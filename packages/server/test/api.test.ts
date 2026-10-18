import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { makeCarcass } from '@vana/sim';
import { positionInPatch, type EncounterTrace } from '@vana/shared';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

let api: FastifyInstance;
let host: SimHost;

beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive cascade');
  host = new SimHost({
    pool: pool!, seed: 3, speciesDir,
    initialAgents: { sambar: 12 }, minPopulation: { sambar: 12 }, landscape: null,
  });
  await host.boot();
  await host.advance(24);
  // Hundreds of reads from one address in seconds: the general read limit is tested in limits.test.ts.
  api = buildApi({ host, pool: pool!, limits: { publicReadsPerMinute: 0 } });
  await api.ready();
});

afterAll(async () => { await api?.close(); await host?.abort(); await pool?.end(); });

maybe('read API', () => {
  it('lists the living animals to watch, by species, a page at a time, with a search by id', async () => {
    const all = (await api.inject({ method: 'GET', url: '/animals' })).json().animals as Array<{ id: string; speciesId: string }>;
    const sambar = all.filter((a) => a.speciesId === 'sambar');
    const page = (await api.inject({ method: 'GET', url: '/animals/list?species=sambar&limit=5' })).json();
    expect(page.total).toBe(sambar.length);
    expect(page.animals).toHaveLength(Math.min(5, sambar.length));
    const first = page.animals[0];
    expect(Object.keys(first).sort()).toEqual(['ageDays', 'id', 'sex', 'speciesId', 'stage', 'state']);
    expect(first.speciesId).toBe('sambar');
    // The age the passport shows (a founder is founded at an age, not newborn).
    expect(first.ageDays).toBe(Math.floor(host.world.agents.find((a) => a.id === first.id)!.ageDays));
    // Pages follow on without repeats, in a fixed order.
    const next = (await api.inject({ method: 'GET', url: '/animals/list?species=sambar&limit=5&offset=5' })).json();
    expect(next.animals.map((a: { id: string }) => a.id)).not.toContain(first.id);
    const everyId = [...page.animals, ...next.animals].map((a: { id: string }) => a.id);
    expect(everyId).toEqual([...everyId].sort());
    // A search by any part of the id.
    const tail = first.id.slice(-3);
    const found = (await api.inject({ method: 'GET', url: `/animals/list?q=${tail}` })).json();
    expect(found.animals.every((a: { id: string }) => a.id.includes(tail))).toBe(true);
    expect(found.animals.map((a: { id: string }) => a.id)).toContain(first.id);
    // Every species when none is named; nonsense refused.
    expect((await api.inject({ method: 'GET', url: '/animals/list' })).json().total).toBe(all.length);
    expect((await api.inject({ method: 'GET', url: '/animals/list?limit=0' })).statusCode).toBe(400);
    expect((await api.inject({ method: 'GET', url: '/animals/list?limit=5000' })).statusCode).toBe(400);
    expect((await api.inject({ method: 'GET', url: '/animals/list?species=' + 'x'.repeat(80) })).statusCode).toBe(400);
  });

  it('maps every living animal, packed by species, each at its position to the metre', async () => {
    const all = (await api.inject({ method: 'GET', url: '/animals' })).json().animals as Array<{ id: string; speciesId: string; position: { x: number; z: number } }>;
    const map = (await api.inject({ method: 'GET', url: '/animals/map' })).json() as { species: Array<{ id: string; ids: string; xz: number[] }> };
    const unpacked = map.species.flatMap((s) => s.ids.split(',').map((tail, i) => ({
      id: tail.startsWith('=') ? tail.slice(1) : `${s.id}_${tail}`, speciesId: s.id, x: s.xz[i * 2]!, z: s.xz[i * 2 + 1]! })));
    expect(unpacked).toHaveLength(all.length);
    const byId = new Map(unpacked.map((a) => [a.id, a]));
    for (const a of all) {
      const m = byId.get(a.id)!;
      expect(m.speciesId).toBe(a.speciesId);
      expect(Math.abs(m.x - a.position.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.z - a.position.z)).toBeLessThanOrEqual(0.5);
    }
  });

  it('reports health', async () => {
    const res = await api.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, worldTime: host.checkpointTime });
  });

  it('reports only durable time while an hour is still in flight', async () => {
    const saved = host.checkpointTime;
    const current = vi.spyOn(host.world, 'now').mockReturnValue(saved! + 3600);
    try {
      const res = await api.inject('/health');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, worldTime: saved });
    } finally { current.mockRestore(); }
  });

  it('marks a listening but stalled world unhealthy until a new durable checkpoint', async () => {
    const later = Date.now() + 16 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect((await api.inject('/health')).statusCode).toBe(503);
      expect((await api.inject('/health')).json().ok).toBe(false);
      const world = await api.inject('/world');
      expect(world.statusCode).toBe(503);
      expect(world.json()).toEqual({ error: 'checkpoint_history_unavailable' });
      expect(host.observation()).toBeNull();
      expect(host.rewardSubject(host.world.agents[0]!.id)).toBeNull();
    } finally { clock.mockRestore(); }
    await host.snapshotNow();
    expect((await api.inject('/health')).statusCode).toBe(200);
  });

  it('maps recorded events, excluding routine activity and events beyond the durable checkpoint', async () => {
    const until = host.checkpointTime!;
    const fixture = { simVersion: 'test', patchId: 0, actors: [host.world.agents[0]!.id], conditions: {},
      outcome: 'success' as const, effects: {}, causalParents: [], confidence: 'authoritative' as const };
    const shown = host.world.log.append({ ...fixture, type: 'born', worldTime: until });
    const future = host.world.log.append({ ...fixture, type: 'died', worldTime: until + 3600 });
    await host.flush();
    expect((await api.inject('/event-map')).json().markers.some((e: { id: string }) => e.id === shown.id)).toBe(false);
    await host.snapshotNow();
    const res = await api.inject('/event-map');
    expect(res.statusCode).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().markers).toContainEqual(expect.objectContaining({ id: shown.id, type: 'born', precision: 'patch' }));
    expect(res.json().markers.some((e: { id: string }) => e.id === future.id)).toBe(false);
    expect(res.json().markers.length).toBeLessThanOrEqual(100);
    expect(res.json().worldTime).toBe(until);
  });

  it('reports a failed scheduled tick without exposing its internal error', async () => {
    host.lastError = 'private database connection details';
    try {
      const res = await api.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json().ok).toBe(false);
      expect(res.body).not.toContain('private');
    } finally { host.lastError = null; }
  });

  it('exposes authoritative terrain time and renderable carcasses without a write route', async () => {
    const patches = (await api.inject({ method: 'GET', url: '/patches' })).json();
    expect(patches.worldTime).toBe(host.world.now());
    const corpse = makeCarcass('test-corpse', 'test-origin', 'sambar', 1, host.world.now(), 'natural', 'authoritative', 100);
    corpse.position = { x: 310, z: 20, heading: 1 };
    host.world.carcasses.push(corpse);
    try {
      expect((await api.inject('/carcasses')).json().carcasses.some((c: { id: string }) => c.id === corpse.id)).toBe(false);
      await host.snapshotNow();
      const body = (await api.inject({ method: 'GET', url: '/carcasses' })).json();
      expect(body.carcasses).toContainEqual(expect.objectContaining({ originId: 'test-origin', speciesId: 'sambar', patchId: 1, decayStage: 1, sizeRatio: expect.any(Number) }));
      expect(body.carcasses.find((c: { id: string }) => c.id === corpse.id).position).toEqual(corpse.position);
      expect((await api.inject({ method: 'POST', url: '/carcasses' })).statusCode).toBe(404);
    } finally { host.world.carcasses.splice(host.world.carcasses.indexOf(corpse), 1); await host.snapshotNow(); }
  });

  it('describes the world clock and season', async () => {
    const body = (await api.inject({ method: 'GET', url: '/world' })).json();
    expect(body.worldTime).toBeGreaterThan(0);
    expect(['monsoon', 'transition', 'dry', 'wet']).toContain(body.season);
    expect(body.population.sambar).toBe(12);
    expect(typeof body.formatted).toBe('string');
    expect(body.worldHoursPerRealHour).toBeGreaterThan(0);
    // Pages that draw a map (a new challenge's) read the world's own grid: 20 patches or the Congo's 160.
    expect(body.grid).toEqual(host.grid);
  });

  it('lists living animals', async () => {
    const body = (await api.inject({ method: 'GET', url: '/animals' })).json();
    expect(body.animals).toHaveLength(12);
    expect(body.animals[0]).toHaveProperty('currentGoal');
    expect(body.animals[0]).toHaveProperty('drives');
    for (const animal of body.animals) {
      expect(positionInPatch(ISLAND_GRID, animal.position, animal.patchId)).toBe(true);
      expect(animal.position).toEqual(host.world.agents.find((a) => a.id === animal.id)!.position);
    }
  });
  it('reports only checkpointed modelled wound status in list and passport', async () => {
    const agent = host.world.agents.find(a => a.alive)!;
    const id = agent.id, now = host.world.now();
    agent.wound = { kind: 'contact_injury', phase: 'open', sourceHuntEventId: 'hunt_fixture',
      woundEventId: 'wounded_fixture', acquiredAt: now - 1, lastUpdatedAt: now,
      severity: 0.4, recoveryRemainingHours: 80, infectionBudget: 1, mortalityBudget: 1 };
    try {
      expect((await api.inject('/animals')).json().animals.find((a: { id: string }) => a.id === id))
        .not.toHaveProperty('woundStatus');
      await host.snapshotNow();
      expect((await api.inject('/animals')).json().animals.find((a: { id: string }) => a.id === id).woundStatus)
        .toBe('open');
      expect((await api.inject(`/animals/${id}/passport`)).json().woundStatus).toBe('open');
      delete agent.wound;
      await host.snapshotNow();
      expect((await api.inject(`/animals/${id}/passport`)).json()).not.toHaveProperty('woundStatus');
    } finally { delete agent.wound; await host.snapshotNow(); }
  });

  it('gives a passport read entirely from checkpoint state and its event log', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const id = list.animals[0].id;
    const res = await api.inject({ method: 'GET', url: `/animals/${id}/passport` });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p).toMatchObject({ id, speciesId: 'sambar', alive: true });
    expect(['male', 'female']).toContain(p.sex);
    expect(typeof p.ageDays).toBe('number');
    expect(typeof p.lifeStage).toBe('string');
    expect(p.thought.text.length).toBeGreaterThan(0);
    expect(p.thought.basis.length).toBeGreaterThan(0);
    expect(p.lineage).toHaveProperty('mother');
    expect(Array.isArray(p.lineage.offspring)).toBe(true);
    expect(p.skills.map((s: { skill: string }) => s.skill)).toContain('water_locations');
    expect(p.death).toBeNull();
    for (const entry of p.timeline) expect(typeof entry.id).toBe('string');
  });

  it('recaps what happened to an animal since a moment, every line tied to an event', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const id = list.animals[0].id;
    const res = await api.inject({ method: 'GET', url: `/animals/${id}/recap?since=0` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.since).toBe(0);
    expect(body.until).toBeGreaterThan(0);
    for (const line of body.lines) {
      expect(typeof line.eventId).toBe('string');
      expect(typeof line.text).toBe('string');
      expect(line.narrated).toBe(false); // no model in tests: templates only
    }
  });

  it('refuses a recap without a starting point', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const res = await api.inject({ method: 'GET', url: `/animals/${list.animals[0].id}/recap` });
    expect(res.statusCode).toBe(400);
  });

  it('gives a whole life to replay: where it went, and what happened', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const id = list.animals[0].id;
    const res = await api.inject({ method: 'GET', url: `/animals/${id}/life` });
    expect(res.statusCode).toBe(200);
    const life = res.json();
    expect(life).toMatchObject({ id, speciesId: 'sambar', alive: true });
    expect(life.track.length).toBeGreaterThan(0);
    for (let i = 1; i < life.track.length; i++) {
      expect(life.track[i].worldTime).toBeGreaterThan(life.track[i - 1].worldTime);
    }
    expect(life.track[0]).toHaveProperty('patchId');
    for (const point of life.track) expect(positionInPatch(ISLAND_GRID, point.position, point.patchId)).toBe(true);
    expect(life.track.at(-1).position).toEqual(host.world.agents.find((a) => a.id === id)!.position);
    expect(Array.isArray(life.moments)).toBe(true);
  });

  it('refuses a life for an animal that never existed', async () => {
    const res = await api.inject({ method: 'GET', url: '/animals/nobody_0000/life' });
    expect(res.statusCode).toBe(404);
  });

  it('returns the same paired trajectory and recorded species through durable life history', async () => {
    const prey = host.world.agents[0]!;
    const trace: EncounterTrace = { version: 1, predatorId: 'fixture-predator', preyId: prey.id,
      patchId: 0, startWorldTime: host.world.now() - 2, contactRadiusM: 1,
      samples: [
        { seconds: 0, phase: 'approach', predator: { x: 0, z: 0, heading: 0 }, prey: { x: 10, z: 0, heading: 0 } },
        { seconds: 2, phase: 'escape', predator: { x: 1, z: 0, heading: 0 }, prey: { x: 20, z: 0, heading: 0 } },
      ] };
    const event = host.world.log.append({ type: 'hunt', worldTime: host.world.now(), simVersion: '',
      patchId: 0, actors: ['fixture-predator', prey.id], conditions: { predatorSpecies: 'tiger', preySpecies: 'sambar', stage: 'escaped' },
      outcome: 'failure', effects: {}, causalParents: [], confidence: 'authoritative', encounter: trace });
    await host.flush();
    expect((await api.inject(`/animals/${prey.id}/life`)).json().encounters.some((e: { eventId: string }) => e.eventId === event.id)).toBe(false);
    await host.snapshotNow();
    const response = await api.inject({ method: 'GET', url: `/animals/${prey.id}/life` });
    expect(response.json().encounters).toContainEqual({ eventId: event.id, outcome: 'failure',
      predatorSpecies: 'tiger', preySpecies: 'sambar', trace });
    expect((await api.inject({ method: 'POST', url: `/animals/${prey.id}/life` })).statusCode).toBe(404);
  });

  it('refuses a passport for an animal that never existed', async () => {
    const res = await api.inject({ method: 'GET', url: '/animals/nobody_0000/passport' });
    expect(res.statusCode).toBe(404);
  });

  it('streams what a thought bubble needs with every animal', async () => {
    const body = (await api.inject({ method: 'GET', url: '/animals' })).json();
    expect(body.animals[0]).toHaveProperty('alternativeGoal');
    expect(body.animals[0]).toHaveProperty('goalScore');
    expect(body.animals[0]).toHaveProperty('dependent');
  });

  it('returns one animal with its live state', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const id = list.animals[0].id;
    const body = (await api.inject({ method: 'GET', url: `/animals/${id}` })).json();
    expect(body.id).toBe(id);
    expect(body.drives).toHaveProperty('hunger');
  });

  it('404s for an unknown animal', async () => {
    expect((await api.inject({ method: 'GET', url: '/animals/nope' })).statusCode).toBe(404);
  });

  it('returns an animal timeline from the event log', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const id = list.animals[0].id;
    const body = (await api.inject({ method: 'GET', url: `/animals/${id}/events` })).json();
    expect(Array.isArray(body.events)).toBe(true);
    for (const e of body.events) expect(e.actors).toContain(id);
  });

  it('exposes no route that mutates the world', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await api.inject({ method, url: '/world' })).statusCode).toBe(404);
    }
  });
});
