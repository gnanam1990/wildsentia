import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;

maybe('database pool', () => {
  const pool = createPool(url!);
  afterAll(async () => { await pool.end(); });

  it('survives a connection dropping, idle or checked out, instead of crashing the server', async () => {
    // An idle client's socket dying makes the pool emit 'error'; with no listener that throws.
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    // A checked-out client's socket dying makes the client itself emit 'error'.
    const client = await pool.connect();
    expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    client.release(true);
    expect((await pool.query('select 1 as one')).rows[0].one).toBe(1);
  });
});
