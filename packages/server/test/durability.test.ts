import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SimHost } from './trackedHost.js';
import type { Pool } from '../src/db/pool.js';
import { EventEmitter } from 'node:events';

function fakePool(query: (sql: string, values: unknown[]) => Promise<unknown>): Pool {
  const client = Object.assign(new EventEmitter(), {
    query: (sql: string, values: unknown[] = []) => sql.includes('pg_try_advisory_lock')
      ? Promise.resolve({ rows: [{ acquired: true }] }) : query(sql, values),
    release: () => undefined,
  });
  return { connect: async () => client } as unknown as Pool;
}

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

describe('event delivery under database failures', () => {
  it('publishes no encounter frame before the matching checkpoint survives a failed save', async () => {
    let fail = false;
    const pool = fakePool(async (sql: string) => {
      if (fail && sql.startsWith('insert into snapshots')) throw new Error('checkpoint offline');
      return { rows: [], rowCount: 0 };
    });
    const host = new SimHost({ pool, seed: 5, speciesDir, initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null });
    await host.boot(); expect(host.liveEncounterFrame()).toBeNull();
    fail = true; await expect(host.advance(1)).rejects.toThrow('checkpoint offline');
    expect(host.liveEncounterFrame()).toBeNull();
    fail = false; await host.advance(0);
    const first = host.liveEncounterFrame()!;
    expect(first).toMatchObject({ startWorldTime: 0, endWorldTime: 3600 });
    await host.snapshotNow();
    expect(host.liveEncounterFrame()!.id).toBe(first.id);
    expect(host.liveEncounterFrame()!.elapsedWorldSeconds).toBeGreaterThanOrEqual(first.elapsedWorldSeconds);
    await host.abort(); expect(host.liveEncounterFrame()).toBeNull();
  });
  it('retries failed track sampling before advancing the world again', async () => {
    let attempts = 0;
    const times: number[][] = [];
    const pool = fakePool(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('insert into tracks')) {
        times.push(values[1] as number[]);
        if (++attempts === 1) throw new Error('track store unavailable');
      }
      return { rows: [], rowCount: 0 };
    });
    const host = new SimHost({ pool, seed: 5, speciesDir, initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null,
      trackEveryWorldHours: 1, snapshotEveryWorldHours: 100, housekeepingEveryWorldHours: 100 });
    await host.boot();
    await expect(host.advance(1)).rejects.toThrow('track store unavailable');
    expect(host.world.now()).toBe(3600);
    await host.advance(0);
    expect(attempts).toBe(2);
    expect(times[1]).toEqual(times[0]);
    expect(host.world.now()).toBe(3600);
  });

  it('retries identical IDs after a partial chunk write, without losing later events', async () => {
    const persisted = new Set<string>();
    let calls = 0;
    let fail = true;
    const pool = fakePool(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('insert into events')) {
        calls++;
        if (calls === 2 && fail) throw new Error('offline');
        const columns = sql.match(/insert into events\s*\(([^)]+)\)/)![1]!.split(',').length;
        expect(values.length % columns).toBe(0);
        for (let i = 0; i < values.length; i += columns) persisted.add(String(values[i]));
      }
      return { rows: [], rowCount: 0 };
    });
    const host = new SimHost({ pool, seed: 5, speciesDir, initialAgents: { sambar: 20 }, minPopulation: {}, landscape: null });
    await host.boot();
    persisted.clear(); calls = 0;
    for (let i = 0; i < 40; i++) host.world.step(1);
    const expected = new Set(host.world.log.all().map((e) => e.id));
    expect(expected.size).toBeGreaterThan(500);
    await expect(host.flush()).rejects.toThrow('offline');
    expect(persisted.size).toBe(500);
    fail = false;
    host.world.step(1);
    for (const e of host.world.log.all()) expected.add(e.id);
    await Promise.all([host.flush(), host.flush()]);
    expect(persisted).toEqual(expected);
    expect(host.world.log.retainedCount()).toBe(0);
    expect(host.world.log.byActor(host.world.agents[0]!.id)).toEqual([]);
  });
});
