import { describe, expect, it } from 'vitest';
import { AgentStore } from '../src/live/liveStore.js';
import type { Pool } from '../src/db/pool.js';

/**
 * Load test, 5 October 2026: every signed agent call wrote last_seen_at. At 250 agents that was
 * about 600 updates a second and up to 84 queries waiting for the 10-connection pool. The column
 * is only read to reap agents unseen for 14 days, so one write a minute per agent is plenty.
 */
describe('AgentStore.touch', () => {
  it('writes an agent\'s last-seen time at most once a minute', async () => {
    const queries: unknown[][] = [];
    const store = new AgentStore({ query: async (...args: unknown[]) => { queries.push(args); return { rows: [], rowCount: 1 }; } } as unknown as Pool);
    let now = 1_000_000;
    for (let i = 0; i < 50; i++) await store.touch('ag_0000000000000001', now += 1000);
    await store.touch('ag_0000000000000002', now);
    expect(queries).toHaveLength(2);
    await store.touch('ag_0000000000000001', now += 60_000);
    expect(queries).toHaveLength(3);
  });

  it('tries again soon after a failed write', async () => {
    let fail = true, writes = 0;
    const store = new AgentStore({ query: async () => { writes++; if (fail) throw new Error('db down'); return { rows: [], rowCount: 1 }; } } as unknown as Pool);
    await expect(store.touch('ag_0000000000000001', 0)).rejects.toThrow('db down');
    fail = false;
    await store.touch('ag_0000000000000001', 1_000);
    expect(writes).toBe(2);
  });
});
