import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;

const event = (id: string, worldTime: number, actor = 'a1'): WorldEvent => ({
  id, type: 'fed', worldTime, simVersion: 'sim_0.1.0', patchId: 3, actors: [actor],
  conditions: { hunger: 0.5 }, outcome: 'success', effects: { kg: 2 },
  causalParents: [], confidence: 'authoritative',
});

const baseSnapshot = {
  simVersion: 'sim_0.1.0', seed: 1, patches: [], agents: [],
  ledger: { imported: 0, exported: 0 }, agentSeq: 0,
  rngState: [1, 2, 3, 4] as [number, number, number, number],
};

afterAll(async () => { await pool?.end(); });

maybe('EventStore', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, human_motion, follows, viewers cascade');
  });

  it('round-trips a batch of events', async () => {
    const store = new EventStore(pool!);
    await store.appendBatch([event('fed_1', 100), event('fed_2', 200)]);
    const recent = await store.recent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.id).toBe('fed_2');
    expect(recent[0]!.conditions).toEqual({ hunger: 0.5 });
    expect(recent[0]!.actors).toEqual(['a1']);
    expect(recent[0]!.worldTime).toBe(200);
  });

  it('round-trips precise lifecycle locations without backfilling legacy or invalid stored locations', async () => {
    const store = new EventStore(pool!);
    const position = { x: 908.125, z: -14.75, heading: 1.5 };
    const birth: WorldEvent = { ...event('birth_location', 100), type: 'born', position };
    const death: WorldEvent = { ...event('death_location', 200), type: 'died', position };
    await store.appendBatch([birth, death, { ...event('legacy_death', 150), type: 'died' }]);
    expect(await store.deathOf('a1')).not.toBeNull();
    const mapped = await store.mapEvents(200);
    expect(mapped.find((e) => e.id === birth.id)).toEqual(birth);
    expect(mapped.find((e) => e.id === death.id)).toEqual(death);
    expect(mapped.find((e) => e.id === 'legacy_death')!.position).toBeUndefined();
    await pool!.query('update events set position=$1::jsonb where id=$2', [JSON.stringify({ ...position, x: 1 }), birth.id]);
    expect((await store.mapEvents(200)).find((e) => e.id === birth.id)!.position).toBeUndefined();
  });

  it('rejects an invalid position anywhere in a multi-chunk batch before inserting anything', async () => {
    const store = new EventStore(pool!);
    const batch = Array.from({ length: 501 }, (_, i) => event(`valid_${i}`, i));
    batch[500]!.position = { x: NaN, z: 0, heading: 0 };
    await expect(store.appendBatch(batch)).rejects.toThrow('recorded patch');
    expect(await store.total()).toBe(0);
  });

  it('preserves joint encounter samples exactly while leaving old events without invented paths', async () => {
    const store = new EventStore(pool!);
    const hunt: WorldEvent = { ...event('hunt_trace', 105), type: 'hunt', actors: ['tiger', 'deer'],
      encounter: { version: 1, predatorId: 'tiger', preyId: 'deer', patchId: 0, startWorldTime: 100,
        contactRadiusM: 1, samples: [{ seconds: 5.125, phase: 'contact',
          predator: { x: 5.75, z: 3.1, heading: 1 }, prey: { x: 6.75, z: 3.1, heading: 1 } }] } };
    await store.appendBatch([event('old', 1), hunt]);
    expect((await store.byActor('deer', 10))[0]).toEqual(hunt);
    expect((await store.byActor('a1', 10))[0]!.encounter).toBeUndefined();
  });

  it('ignores a duplicate id instead of failing the batch', async () => {
    const store = new EventStore(pool!);
    await store.appendBatch([event('fed_1', 100)]);
    await store.appendBatch([event('fed_1', 100), event('fed_2', 200)]);
    expect(await store.total()).toBe(2);
  });

  it('preserves ordinary movement samples without inventing routes for legacy events', async () => {
    const store = new EventStore(pool!);
    const movement: WorldEvent = { ...event('move_route', 105), type: 'moved', movement: {
      version: 1, actorId: 'a1', startWorldTime: 100, destinationPatchId: 4, goal: 'find_water', completed: false,
      samples: [{ seconds: 0, position: { x: 10, z: 30, heading: 0 } },
        { seconds: 5.25, position: { x: 15.25, z: 30, heading: 1.57 } }],
    } };
    await store.appendBatch([event('legacy', 1), movement]);
    const events = await store.byActor('a1', 10);
    expect(events.find((e) => e.id === movement.id)).toEqual(movement);
    expect(events.find((e) => e.id === 'legacy')!.movement).toBeUndefined();
  });

  it('finds events by actor, newest first', async () => {
    const store = new EventStore(pool!);
    await store.appendBatch([event('fed_1', 100, 'tiger'), event('fed_2', 200, 'deer'), event('fed_3', 300, 'tiger')]);
    expect((await store.byActor('tiger', 10)).map((e) => e.id)).toEqual(['fed_3', 'fed_1']);
  });

  it('finds an animal\'s death however much happened to its carcass afterwards', async () => {
    const store = new EventStore(pool!);
    // A death names the dead first and its killer, if any, second.
    const died: WorldEvent = { ...event('died_1', 100), type: 'died', actors: ['sambar_1', 'tiger_1'] };
    const scavenged = Array.from({ length: 60 }, (_, i) =>
      ({ ...event(`scav_${i}`, 200 + i), type: 'scavenged' as const, actors: ['vulture_1', 'sambar_1'] }));
    await store.appendBatch([died, ...scavenged]);
    expect((await store.byActor('sambar_1', 50)).some((e) => e.type === 'died')).toBe(false);
    expect((await store.deathOf('sambar_1'))?.id).toBe('died_1');
    expect(await store.deathOf('sambar_2')).toBeNull();
    // The tiger is in that record as the killer; it is not the tiger's death.
    expect(await store.deathOf('tiger_1')).toBeNull();
  });

  it('returns an animal\'s events since a moment, oldest first', async () => {
    const store = new EventStore(pool!);
    await store.appendBatch([event('e1', 100), event('e2', 200), event('e3', 300), event('x1', 250, 'other')]);
    expect((await store.byActorSince('a1', 150, 100)).map((e) => e.id)).toEqual(['e2', 'e3']);
    await store.appendBatch([{ ...event('b1', 260), type: 'born' }]);
    expect((await store.byActorSince('a1', 150, 100, ['born'])).map((e) => e.id)).toEqual(['b1']);
  });

  it('counts and deletes events after a world time', async () => {
    const store = new EventStore(pool!);
    await store.appendBatch([event('fed_1', 100), event('fed_2', 200), event('fed_3', 300)]);
    expect(await store.countAfter(150)).toBe(2);
    expect(await store.deleteAfter(150)).toBe(2);
    expect(await store.total()).toBe(1);
  });

  it('uses the exclusive sequence boundary for equal-timestamp current IDs without deleting legacy history', async () => {
    const store = new EventStore(pool!);
    const id = (n: number) => `born_00000001${n.toString(16).padStart(16, '0')}`;
    const entries = [2, 3, 4].map((n) => ({ ...event(id(n), 100), type: 'born' as const }));
    await store.appendBatch([...entries, { ...event('born_12345678', 100), type: 'born' }, { ...event('old', 99), type: 'born' }]);
    expect((await store.mapEvents(100, 3)).map((e) => e.id).sort()).toEqual([id(2), 'old'].sort());
    expect(await store.countAfter(100, 3)).toBe(2);
    expect(await store.deleteAfter(100, 3)).toBe(2);
    expect((await store.recent(10)).map((e) => e.id).sort()).toEqual([id(2), 'born_12345678', 'old'].sort());
  });

  it('applies the same checkpoint to feeds, timelines, death lookups and sequence-aware recaps before limiting', async () => {
    const store = new EventStore(pool!);
    const id = (n: number) => `died_00000001${n.toString(16).padStart(16, '0')}`;
    const entries = [2, 3, 4].map((n) => ({ ...event(id(n), 100), type: 'died' as const }));
    await store.appendBatch(entries);
    const boundary = { worldTime: 100, nextSequence: 4 };
    expect((await store.recent(1, boundary))[0]!.id).not.toBe(id(4));
    expect((await store.byActor('a1', 100, boundary)).map((e) => e.id).sort()).toEqual([id(2), id(3)]);
    expect((await store.deathOf('a1', { worldTime: 100, nextSequence: 2 }))).toBeNull();
    expect((await store.byActorSince('a1', 100, 100, ['died'], boundary, 3)).map((e) => e.id)).toEqual([id(3)]);
    expect((await store.byActorSince('a1', 100, 100, ['died'], boundary, null)).map((e) => e.id).sort()).toEqual([id(2), id(3)]);
    expect(await store.byActorSince('a1', 100, 100, ['died'], boundary)).toEqual([]);
  });
});

maybe('SnapshotStore', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, human_motion, follows, viewers cascade');
  });

  it('returns null when empty', async () => {
    expect(await new SnapshotStore(pool!).loadLatest()).toBeNull();
  });

  it('loads the newest snapshot by world time', async () => {
    const store = new SnapshotStore(pool!);
    await store.save({ ...baseSnapshot, worldTime: 100 });
    await store.save({ ...baseSnapshot, worldTime: 300 });
    await store.save({ ...baseSnapshot, worldTime: 200 });
    expect((await store.loadLatest())!.worldTime).toBe(300);
  });

  it('prunes all but the newest N', async () => {
    const store = new SnapshotStore(pool!);
    for (const t of [100, 200, 300, 400, 500]) await store.save({ ...baseSnapshot, worldTime: t });
    expect(await store.prune(2)).toBe(3);
    expect((await store.loadLatest())!.worldTime).toBe(500);
  });

  it('keeps the newest of several checkpoints at one world time, and counts world times not rows', async () => {
    const store = new SnapshotStore(pool!);
    await pool!.query('truncate snapshots');
    for (const t of [100, 200, 200, 200, 300]) await store.save({ ...baseSnapshot, worldTime: t, rngState: t as never });
    await store.save({ ...baseSnapshot, worldTime: 300, simVersion: 'newest-at-300' as never });
    expect(await store.prune(2)).toBe(4); // 100, two older 200s, the older 300.
    expect((await store.loadLatest())!.simVersion).toBe('newest-at-300');
    expect((await pool!.query('select count(*)::int as n from snapshots')).rows[0].n).toBe(2);
  });
});
