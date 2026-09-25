import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { LifeStore } from '../src/db/lifeStore.js';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { Narrator } from '../src/narration/narrator.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null;
const maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 44, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 12, trackEveryWorldHours: 1 });
afterAll(async () => { await pool?.end(); });
maybe('checkpoint-consistent observer history', () => {
  beforeEach(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade');
  });
  it('withholds volatile birth/death, kinship, tracks and model narration across every history route until checkpoint', async () => {
    const host = new SimHost(options()); await host.boot();
    const [mother, dying] = host.world.agents;
    mother!.sex = 'female'; mother!.pregnantSince = -host.world.species.get('sambar')!.lifecycle.gestationDays * 86400;
    mother!.drives = { hunger: 0, thirst: 0, fatigue: 1, fear: 0 }; dying!.drives.hunger = 1;
    await host.snapshotNow();
    const before = host.observation()!, calls: string[] = [];
    const narrator = new Narrator({ pool: pool!, dailyTokenBudget: 1000,
      rephrase: async (text) => { calls.push(text); return { text, tokens: 1, model: 'local-test' }; } });
    const api = buildApi({ host, pool: pool!, narrator });
    try {
      await host.advance(1);
      const newborn = host.world.agents.find((a) => a.motherId === mother!.id)!;
      expect(newborn).toBeDefined(); expect(dying!.alive).toBe(false);
      const passport = (await api.inject(`/animals/${dying!.id}/passport`)).json();
      expect(passport).toMatchObject({ alive: true, death: null, asOfWorldTime: before.worldTime, nextEventSequence: before.nextSequence });
      expect(passport.drives).toEqual(before.animal(dying!.id)!.drives);
      expect((await api.inject(`/animals/${mother!.id}/passport`)).json().lineage.offspring).toEqual([]);
      for (const suffix of ['passport', 'life']) expect((await api.inject(`/animals/${newborn.id}/${suffix}`)).statusCode).toBe(404);
      const life = (await api.inject(`/animals/${dying!.id}/life`)).json();
      expect(life).toMatchObject({ alive: true, departedAt: null, asOfWorldTime: before.worldTime });
      expect(life.track.every((p: { worldTime: number }) => p.worldTime <= before.worldTime)).toBe(true);
      expect(life.moments).toEqual([]);
      for (const path of ['/events?limit=500', `/animals/${dying!.id}/events?limit=500`]) {
        const response = await api.inject(path);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json().events.some((e: { type: string }) => ['born', 'died', 'carcass_created'].includes(e.type))).toBe(false);
      }
      const recap = (await api.inject(`/animals/${mother!.id}/recap?since=0&sinceSequence=${before.nextSequence}`)).json();
      expect(recap.lines).toEqual([]); expect(recap.until).toBe(0);
      await narrator.idle(); expect(calls).toEqual([]);
      await host.snapshotNow();
      const savedDeath = (await api.inject(`/animals/${dying!.id}/passport`)).json();
      expect(savedDeath.alive).toBe(false); expect(savedDeath.death).not.toBeNull();
      expect(savedDeath.asOfWorldTime).toBe(3600);
      expect((await api.inject(`/animals/${newborn.id}/life`)).json()).toMatchObject({ alive: true, asOfWorldTime: 3600 });
      expect((await api.inject(`/animals/${mother!.id}/passport`)).json().lineage.offspring).toContainEqual({ id: newborn.id, alive: true });
      const savedRecap = (await api.inject(`/animals/${mother!.id}/recap?since=0&sinceSequence=${before.nextSequence}`)).json();
      expect(savedRecap.lines.some((l: { text: string }) => l.text.includes(newborn.id))).toBe(true);
      await narrator.idle(); expect(calls.length).toBeGreaterThan(0);
    } finally { await narrator.idle(); await api.close(); }
  });

  it('pins animal state and event cutoff across an awaited query while the next checkpoint publishes', async () => {
    const host = new SimHost(options()); await host.boot();
    const id = host.world.agents[0]!.id, view = host.observation()!;
    const original = EventStore.prototype.byActor;
    const spy = vi.spyOn(EventStore.prototype, 'byActor').mockImplementation(async function (...args) {
      host.world.agents[0]!.drives.hunger = 1;
      await host.advance(1); await host.snapshotNow();
      return original.apply(this, args);
    });
    const api = buildApi({ host, pool: pool! });
    try {
      const response = await api.inject(`/animals/${id}/passport`);
      expect(host.checkpointTime).toBe(3600);
      expect(response.json()).toMatchObject({ alive: true, death: null, asOfWorldTime: 0 });
      expect(response.json().timeline.some((e: { type: string }) => e.type === 'died')).toBe(false);
      expect(response.json().drives).toEqual(view.animal(id)!.drives);
      spy.mockRestore();
      expect((await api.inject(`/animals/${id}/passport`)).json()).toMatchObject({ alive: false, asOfWorldTime: 3600 });
    } finally { spy.mockRestore(); await api.close(); }
  });

  it('returns detached immutable-in-time views without granting simulation or checkpoint write access', async () => {
    const host = new SimHost(options()); await host.boot();
    const id = host.world.agents[0]!.id, view = host.observation()!, original = view.animal(id)!;
    const altered = view.animal(id)!; altered.drives.hunger = 1; altered.offspringIds.push('fake-child');
    expect(view.animal(id)).toEqual(original); expect(host.world.agents[0]!.offspringIds).not.toContain('fake-child');
    host.world.agents[0]!.drives.hunger = 1; await host.advance(1); await host.snapshotNow();
    expect(view.animal(id)!.alive).toBe(true); expect(view.worldTime).toBe(0);
    expect(host.observation()!.animal(id)!.alive).toBe(false);
  });

  it('fails history routes closed while writer health is unknown, without exposing internal errors', async () => {
    const host = new SimHost(options()); await host.boot(); const id = host.world.agents[0]!.id;
    const api = buildApi({ host, pool: pool! }); host.lastError = 'private database diagnostics';
    try {
      for (const path of ['/events', '/event-map', `/animals/${id}/passport`, `/animals/${id}/life`, `/animals/${id}/events`, `/animals/${id}/recap?since=0`]) {
        const res = await api.inject(path); expect(res.statusCode).toBe(503); expect(res.body).not.toContain('private');
      }
    } finally { host.lastError = null; await api.close(); }
  });

  it('requires a committed departure for an archived fallback exactly at the checkpoint boundary', async () => {
    const host = new SimHost(options()); await host.boot();
    const archived = { ...structuredClone(host.world.agents[0]!), id: 'archived-boundary', alive: false, departedAt: 0 };
    await new LifeStore(pool!).archive([archived]);
    host.world.log.append({ type: 'died', worldTime: 0, simVersion: '', patchId: archived.patchId,
      actors: [archived.id], conditions: { cause: 'natural' }, effects: {}, outcome: 'success', causalParents: [], confidence: 'authoritative' });
    await host.flush(); const api = buildApi({ host, pool: pool! });
    try {
      expect((await api.inject(`/animals/${archived.id}/passport`)).statusCode).toBe(404);
      await host.snapshotNow();
      expect((await api.inject(`/animals/${archived.id}/passport`)).json()).toMatchObject({ alive: false, death: { cause: 'natural' } });
    } finally { await api.close(); }
  });

  it('rejects invalid lower cursor values instead of querying PostgreSQL with fractional or overflowing bounds', async () => {
    const host = new SimHost(options()); await host.boot(); const api = buildApi({ host, pool: pool! });
    try {
      for (const query of ['since=0.5', 'since=-2', 'since=1e30', 'since=0&sinceSequence=-1', 'since=0&sinceSequence=1.5', 'since=0&sinceSequence=9007199254740992'])
        expect((await api.inject(`/animals/a/recap?${query}`)).statusCode).toBe(400);
    } finally { await api.close(); }
  });
});
