import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';

const url = process.env.DATABASE_URL;
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
    await pool!.query('truncate events, snapshots, follows, viewers cascade');
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

  it('ignores a duplicate id instead of failing the batch', async () => {
    const store = new EventStore(pool!);
    await store.appendBatch([event('fed_1', 100)]);
    await store.appendBatch([event('fed_1', 100), event('fed_2', 200)]);
    expect(await store.total()).toBe(2);
  });

  it('finds events by actor, newest first', async () => {
    const store = new EventStore(pool!);
    await store.appendBatch([event('fed_1', 100, 'tiger'), event('fed_2', 200, 'deer'), event('fed_3', 300, 'tiger')]);
    expect((await store.byActor('tiger', 10)).map((e) => e.id)).toEqual(['fed_3', 'fed_1']);
  });

  it('counts and deletes events after a world time', async () => {
    const store = new EventStore(pool!);
    await store.appendBatch([event('fed_1', 100), event('fed_2', 200), event('fed_3', 300)]);
    expect(await store.countAfter(150)).toBe(2);
    expect(await store.deleteAfter(150)).toBe(2);
    expect(await store.total()).toBe(1);
  });
});

maybe('SnapshotStore', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, follows, viewers cascade');
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
});
