import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { LifeStore, ROUTINE_EVENT_TYPES } from '../src/db/lifeStore.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

const ev = (id: string, type: WorldEvent['type'], worldTime: number): WorldEvent => ({
  id, type, worldTime, simVersion: 'sim_0.5.0', patchId: 1, actors: ['chital_0001'],
  conditions: {}, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative',
});

maybe('LifeStore', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, tracks, animal_archive');
  });

  it('round-trips care provenance, prunes routine provisioning and retains lost-parent history', async () => {
    const events = new EventStore(pool!), life = new LifeStore(pool!);
    const care = { ...ev('care1', 'provisioned', 100), actors: ['dhole_child', 'dhole_mother'],
      conditions: { source: 'parent_reserves' }, effects: { foodEquivalentKg: 0.1, waterEquivalentL: 0.2 } };
    const loss = { ...ev('loss1', 'parent_lost', 200), actors: care.actors, outcome: 'interrupted' as const };
    await events.appendBatch([care, loss]);
    expect((await events.byActorSince('dhole_child', 0, 10))[0]).toEqual(care);
    await life.pruneRoutine(300);
    expect(await events.byActorSince('dhole_child', 0, 10)).toEqual([loss]);
  });

  it('round-trips precise positions while retaining unknown precision for legacy tracks', async () => {
    const store = new LifeStore(pool!);
    const base = { id: 'sambar_precise', worldTime: 100, patchId: 0, state: 'resting', goal: 'rest',
      drives: { hunger: 0.2, thirst: 0.1, fatigue: 0.3, fear: 0 } };
    const position = { x: 12.123456789, z: -34.5678912, heading: 1.23 };
    await store.appendTracks([base, { ...base, worldTime: 200, position }]);
    const track = await store.trackOf(base.id);
    expect(track[0]!.position).toBeUndefined();
    expect(track[1]!.position).toEqual(position);
    await store.appendTracks([{ ...base, worldTime: 200, position: { x: 20, z: 30, heading: 0 } }]);
    expect((await store.trackOf(base.id))[1]!.position).toEqual(position);
  });

  it('rejects invalid or wrong-patch coordinates without partially appending the batch', async () => {
    const store = new LifeStore(pool!);
    const base = { id: 'bad_coordinate', worldTime: 100, patchId: 0, state: 'resting', goal: 'rest',
      drives: { hunger: 0.2, thirst: 0.1, fatigue: 0.3, fear: 0 } };
    await expect(store.appendTracks([base, { ...base, worldTime: 200, position: { x: 900, z: 0, heading: 0 } }]))
      .rejects.toThrow('invalid track position');
    expect(await store.trackOf(base.id)).toEqual([]);
  });

  it('records where an animal was, and returns its track in time order', async () => {
    const store = new LifeStore(pool!);
    const at = (t: number, patchId: number) => ({
      id: 'chital_0001', worldTime: t, patchId, state: 'grazing', goal: 'find_food',
      drives: { hunger: 0.2, thirst: 0.1, fatigue: 0.3, fear: 0 },
    });
    await store.appendTracks([at(200, 5), at(100, 4)]);
    await store.appendTracks([at(200, 5)]); // a restart may sample the same hour twice
    const track = await store.trackOf('chital_0001');
    expect(track.map((p) => [p.worldTime, p.patchId])).toEqual([[100, 4], [200, 5]]);
    expect(track[0]!.drives.hunger).toBeCloseTo(0.2);
  });

  it('returns a long life at a bounded number of points, keeping its first and last', async () => {
    // An elephant sampled every six hours for fifty years is 84,000 points: tens of megabytes
    // for one replay. The path is thinned evenly instead.
    const store = new LifeStore(pool!);
    const point = (t: number) => ({
      id: 'elephant_0001', worldTime: t, patchId: t % 400, state: 'grazing', goal: 'find_food',
      drives: { hunger: 0.2, thirst: 0.1, fatigue: 0.3, fear: 0 },
    });
    await store.appendTracks(Array.from({ length: 5000 }, (_, i) => point((i + 1) * 21_600)));
    const track = await store.trackOf('elephant_0001', 1000);
    expect(track.length).toBeLessThanOrEqual(1001);
    expect(track.length).toBeGreaterThan(900);
    expect(track[0]!.worldTime).toBe(21_600);
    expect(track[track.length - 1]!.worldTime).toBe(5000 * 21_600);
  });

  it('thins old samples: daily after a season, weekly after two years', async () => {
    const store = new LifeStore(pool!);
    const day = 86_400;
    const point = (t: number) => ({
      id: 'gaur_0001', worldTime: t, patchId: 1, state: 'resting', goal: 'rest',
      drives: { hunger: 0.2, thirst: 0.1, fatigue: 0.3, fear: 0 },
    });
    // Six-hourly samples across three years.
    await store.appendTracks(Array.from({ length: 3 * 360 * 4 }, (_, i) => point((i + 1) * 6 * 3600)));
    const now = 3 * 360 * day;
    await store.thinTracks(now, 90, 730);
    const times = (await store.trackOf('gaur_0001', 100_000)).map((p) => p.worldTime);
    const older = times.filter((t) => t < now - 730 * day);
    const middle = times.filter((t) => t >= now - 730 * day && t < now - 90 * day);
    const recent = times.filter((t) => t >= now - 90 * day);
    expect(older.every((t) => t % (7 * day) === 0)).toBe(true);
    expect(middle.every((t) => t % day === 0)).toBe(true);
    expect(recent.length).toBe(90 * 4 + 1); // both ends of the window are samples
  });

  it('prunes routine events past their window and keeps everything that matters', async () => {
    // At the live pace the log gains over two million routine events a real day. They serve the
    // live feed; the life story is carried by the rest and by the track.
    const events = new EventStore(pool!);
    await events.appendBatch([
      ev('m_old', 'moved', 100), ev('f_old', 'fed', 100), ev('b_old', 'born', 100),
      ev('h_old', 'hunt', 100), ev('m_new', 'moved', 900),
    ]);
    const removed = await new LifeStore(pool!).pruneRoutine(500);
    expect(removed).toBe(2);
    const left = (await events.recent(10)).map((e) => e.id).sort();
    expect(left).toEqual(['b_old', 'h_old', 'm_new']);
    expect(ROUTINE_EVENT_TYPES).not.toContain('born');
  });

  it('archives the departed and reads them back', async () => {
    const store = new LifeStore(pool!);
    const record = { id: 'chital_0009', speciesId: 'chital', departedAt: 300, alive: false } as never;
    await store.archive([record]);
    await store.archive([record]);
    expect((await store.archived('chital_0009'))?.speciesId).toBe('chital');
    expect(await store.archived('nobody_0000')).toBeNull();
    expect(await store.archived('chital_0009', 299)).toBeNull();
    expect((await store.archived('chital_0009', 300))?.id).toBe('chital_0009');
  });

  it('filters future replay samples before thinning so future rows cannot displace committed first/last samples', async () => {
    const store = new LifeStore(pool!);
    await store.appendTracks(Array.from({ length: 100 }, (_, i) => ({ id: 'bounded-life', worldTime: i,
      patchId: 0, state: 'resting', goal: 'rest', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } })));
    const points = await store.trackOf('bounded-life', 3, 10);
    expect(points[0]!.worldTime).toBe(0); expect(points.at(-1)!.worldTime).toBe(10);
    expect(points.every((p) => p.worldTime <= 10)).toBe(true); expect(points.length).toBeLessThanOrEqual(4);
  });
});
