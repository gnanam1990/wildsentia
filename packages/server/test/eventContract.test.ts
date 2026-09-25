import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { EventStore, eventSequence } from '../src/db/eventStore.js';
import type { Pool } from '../src/db/pool.js';

describe('event SQL binding contract (not a PostgreSQL integration test)', () => {
  it('binds sixteen values per row, including nullable or JSON traces, positions and sequence', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = { query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values }); return { rows: [], rowCount: 0 };
    } } as unknown as Pool;
    const event: WorldEvent = { id: 'h1', type: 'hunt', worldTime: 10, simVersion: 'sim_0.6.0',
      patchId: 0, actors: ['tiger', 'deer'], conditions: {}, effects: {}, outcome: 'failure',
      causalParents: [], confidence: 'authoritative' };
    const withTrace: WorldEvent = { ...event, id: 'h2', encounter: { version: 1, predatorId: 'tiger',
      preyId: 'deer', startWorldTime: 0, patchId: 0, contactRadiusM: 1,
      samples: [{ seconds: 10, phase: 'escape', predator: { x: 0, z: 0, heading: 0 },
        prey: { x: 10, z: 0, heading: 0 } }] } };
    const withMove: WorldEvent = { ...event, id: 'm1', type: 'moved', movement: { version: 1,
      actorId: 'tiger', startWorldTime: 0, destinationPatchId: 1, goal: 'wander', completed: false,
      samples: [{ seconds: 0, position: { x: 0, z: 0, heading: 0 } }, { seconds: 1, position: { x: 1, z: 0, heading: 0 } }] } };
    const birth: WorldEvent = { ...event, id: 'born_00000001000000000000002a', type: 'born', position: { x: 15.125, z: -6.5, heading: 1.2 } };
    await new EventStore(pool).appendBatch([event, withTrace, withMove, birth]);
    const { sql, values } = calls[0]!;
    const columns = sql.match(/insert into events\s*\(([^)]+)\)/)![1]!.split(',').map((s) => s.trim());
    expect(columns).toHaveLength(16); expect(columns.at(-1)).toBe('event_sequence');
    expect(values).toHaveLength(64); expect(values[0]).toBe('h1'); expect(values[16]).toBe('h2');
    expect(values[12]).toBeNull(); expect(values[13]).toBeNull(); expect(values[14]).toBeNull();
    expect(values[15]).toBeNull();
    expect(JSON.parse(String(values[28]))).toEqual(withTrace.encounter);
    expect(JSON.parse(String(values[45]))).toEqual(withMove.movement);
    expect(JSON.parse(String(values[62]))).toEqual(birth.position);
    expect(values[63]).toBe(42);
    expect([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
  });

  it('extracts only the current safe deterministic ID format, never legacy or overflowing IDs', () => {
    expect(eventSequence('born_00000001000000000000002a')).toBe(42);
    expect(eventSequence('died_00000001001fffffffffffff')).toBe(Number.MAX_SAFE_INTEGER);
    for (const id of ['died_12345678', 'maintenance_19abc', 'born_000000010020000000000000', 'born_00000001ffffffffffffffff', 'born_not-hex'])
      expect(eventSequence(id)).toBeNull();
  });
});
