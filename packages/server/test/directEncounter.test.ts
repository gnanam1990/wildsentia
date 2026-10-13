import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { EncounterTrace } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { LifeStore } from '../src/db/lifeStore.js';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { loadSelectedEncounter } from '../../client/src/lifeHistory.js';
import { HistoryPager } from '../../client/src/history.js';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 44, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: { sambar: 3 }, minPopulation: {}, landscape: null });
afterAll(async () => { await pool?.end(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
maybe('direct durable encounter retrieval', () => {
  beforeEach(async () => { await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade'); });
  const start = async (samples = 2) => {
    const host = new SimHost(options()); await host.boot();
    const [predator, prey, other] = host.world.agents;
    const trace: EncounterTrace = { version: 1, predatorId: predator!.id, preyId: prey!.id, patchId: 0,
      startWorldTime: 0, contactRadiusM: 1, samples: Array.from({ length: samples }, () => ({ seconds: 0, phase: 'escape' as const,
        predator: { x: 0, z: 0, heading: 0 }, prey: { x: 10, z: 0, heading: 0 } })) };
    const event = host.world.log.append({ type: 'hunt', worldTime: 0, simVersion: '', patchId: 0, actors: [predator!.id, prey!.id],
      conditions: { predatorSpecies: 'sambar', preySpecies: 'sambar', stage: 'escaped' }, outcome: 'failure', effects: {},
      causalParents: [], confidence: 'authoritative', encounter: trace });
    return { host, predator: predator!, prey: prey!, other: other!, event, trace };
  };
  it('withholds uncheckpointed recordings and scopes primary-key reads to their real participants', async () => {
    const { host, predator, prey, other, event, trace } = await start();
    await host.flush(); const api = buildApi({ host, pool: pool! });
    const path = (id: string) => `/animals/${id}/encounters/${event.id}`;
    try {
      expect((await api.inject(path(prey.id))).statusCode).toBe(404);
      await host.snapshotNow();
      for (const participant of [predator, prey]) {
        const res = await api.inject(path(participant.id)); expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json()).toMatchObject({ id: participant.id, scope: 'encounter', source: 'checkpoint',
          encounter: { eventId: event.id, trace } });
        expect(res.json()).not.toHaveProperty('track'); expect(res.json()).not.toHaveProperty('moments');
      }
      expect((await api.inject(path(other.id))).statusCode).toBe(404);
      expect((await api.inject(`/animals/${prey.id}/encounters/missing`)).statusCode).toBe(404);
      host.lastError = 'private-error';
      const failed = await api.inject(path(prey.id)); expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain('private');
      host.lastError = null;
      expect((await api.inject({ method: 'POST', url: path(prey.id) })).statusCode).toBe(404);
      // Even an accidentally overbroad actors array must not advertise a third participant.
      await pool!.query('update events set actors = array_append(actors, $1) where id=$2', [other.id, event.id]);
      expect((await api.inject(path(other.id))).statusCode).toBe(404);
    } finally { host.lastError = null; await api.close(); }
  });
  it('loads one selected recording without listing events or querying a life track, including after restart', async () => {
    const { host, prey, event, trace } = await start(); await host.snapshotNow();
    const api = buildApi({ host, pool: pool! });
    try {
      const pages = vi.spyOn(EventStore.prototype, 'page'), tracks = vi.spyOn(LifeStore.prototype, 'trackOf');
      const fetcher = vi.fn(async (url: string) => { const r = await api.inject(url.replace('/api/', '/')); return new Response(r.body, { status: r.statusCode }); });
      vi.stubGlobal('fetch', fetcher);
      const loaded = await loadSelectedEncounter(prey.id, event.id, new AbortController().signal);
      expect(fetcher).toHaveBeenCalledTimes(1); expect(pages).not.toHaveBeenCalled(); expect(tracks).not.toHaveBeenCalled();
      expect(loaded.track).toEqual([]); expect(loaded.moments).toEqual([]);
      expect(loaded.encounters).toEqual([{ eventId: event.id, outcome: 'failure', predatorSpecies: 'sambar', preySpecies: 'sambar', trace }]);
      await host.abort(); const restored = new SimHost(options()); await restored.boot();
      const restarted = buildApi({ host: restored, pool: pool! });
      try { expect((await restarted.inject(`/animals/${prey.id}/encounters/${event.id}`)).json().encounter.trace).toEqual(trace); }
      finally { await restarted.close(); }
    } finally { await api.close(); }
  });
  it('pins metadata across an awaited query and still retrieves an archived dead participant', async () => {
    const { host, prey, event } = await start(); await host.snapshotNow();
    const api = buildApi({ host, pool: pool! }), original = EventStore.prototype.encounterById;
    const spy = vi.spyOn(EventStore.prototype, 'encounterById').mockImplementationOnce(async function (...args) {
      prey.drives.hunger = 1; await host.advance(1); await host.snapshotNow();
      return original.apply(this, args);
    });
    try {
      const path = `/animals/${prey.id}/encounters/${event.id}`;
      expect((await api.inject(path)).json()).toMatchObject({ alive: true, asOfWorldTime: 0 });
      expect(prey.alive).toBe(false); spy.mockRestore();
      await new LifeStore(pool!, ISLAND_GRID).archive([prey]);
      // Hourly deaths can remain in agents until the next compaction. Model archival from
      // either collection explicitly; never remove an unrelated final item with splice(-1).
      for (const collection of [host.world.agents, host.world.deceased]) {
        const index = collection.findIndex(a => a.id === prey.id);
        if (index >= 0) collection.splice(index, 1);
      }
      await host.snapshotNow();
      expect(host.observation()!.animal(prey.id)).toBeUndefined();
      expect((await api.inject(path)).json()).toMatchObject({ alive: false, asOfWorldTime: 3600, encounter: { eventId: event.id } });
    } finally { spy.mockRestore(); await api.close(); }
  });
  it('projects geometry out of list responses while preserving raw access and bound summary cursors', async () => {
    const { host, prey, event } = await start(10_000);
    const moved = host.world.log.append({ type: 'moved', worldTime: 0, simVersion: '', patchId: 0, actors: [prey.id],
      conditions: {}, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative', movement: {
        version: 1, actorId: prey.id, startWorldTime: 0, destinationPatchId: 0, goal: 'wander', completed: true,
        samples: Array.from({ length: 2048 }, (_, seconds) => ({ seconds, position: { x: 0, z: 0, heading: 0 } })),
      } });
    await host.snapshotNow(); const api = buildApi({ host, pool: pool! });
    try {
      const base = `/animals/${prey.id}/events`;
      const raw = await api.inject(base), summary = await api.inject(`${base}?view=summary`);
      expect(summary.statusCode).toBe(200); expect(summary.body.length).toBeLessThan(raw.body.length / 100);
      const summaries = summary.json().events;
      expect(summaries.find((e: { id: string }) => e.id === event.id)).toMatchObject({ hasEncounter: true });
      expect(summaries.find((e: { id: string }) => e.id === moved.id)).toMatchObject({ hasEncounter: false });
      for (const e of summaries) { expect(e).not.toHaveProperty('encounter'); expect(e).not.toHaveProperty('movement'); }
      expect(raw.json().events.find((e: { id: string }) => e.id === event.id).encounter.samples).toHaveLength(10_000);
      const page = (await api.inject(`${base}?view=summary&limit=1`)).json();
      expect((await api.inject(`${base}?cursor=${page.nextCursor}`)).statusCode).toBe(400);
      expect((await api.inject(`${base}?view=summary&cursor=${page.nextCursor}`)).statusCode).toBe(200);
      expect((await api.inject(`${base}?view=bogus`)).statusCode).toBe(400);
      vi.stubGlobal('fetch', async (url: string) => { const r = await api.inject(url.replace('/api/', '/')); return new Response(r.body, { status: r.statusCode }); });
      const pager = new HistoryPager(); await pager.open(prey.id);
      expect(pager.error).toBe(''); expect(pager.page!.events.find(e => e.id === event.id)!.hasEncounter).toBe(true);
    } finally { await api.close(); }
  });
});
