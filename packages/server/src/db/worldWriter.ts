import type { PoolClient } from 'pg';
import type { Database, Pool } from './pool.js';

/** One world per database. All world writes use this SAME lock-owning connection, never pool.query. */
export class WorldWriter implements Database {
  #client: PoolClient | null = null;
  #active = false;
  #lost = false;
  constructor(private readonly pool: Pool, private readonly onLost: () => void) {}

  readonly #connectionLost = (): void => {
    if (this.#lost) return;
    this.#lost = true; this.#active = false;
    this.onLost();
  };

  assertActive(): void {
    if (!this.#active || this.#lost || this.#client === null) throw new Error('world writer is not active');
  }

  get active(): boolean { return this.#active && !this.#lost && this.#client !== null; }

  get query(): Database['query'] {
    this.assertActive();
    return this.#client!.query.bind(this.#client!) as Database['query'];
  }

  /** Takes the lock, waiting up to `waitMs` for another writer (an old deployment shutting down) to let go. */
  async acquire(waitMs = 0): Promise<void> {
    if (this.#client !== null || this.#lost) throw new Error('world writer cannot be reacquired');
    const client = await this.pool.connect();
    this.#client = client;
    client.on('error', this.#connectionLost);
    client.on('end', this.#connectionLost);
    try {
      const until = Date.now() + waitMs;
      for (;;) {
        const { rows } = await client.query<{ acquired: boolean }>(
          'select pg_try_advisory_lock(1447112257, 1) as acquired');
        if (rows[0]?.acquired) break;
        if (Date.now() >= until || this.#lost) throw new Error('another world writer already owns this database');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (this.#lost) throw new Error('world writer connection lost during acquisition');
      this.#active = true;
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  async release(): Promise<void> {
    const client = this.#client;
    if (client === null) return;
    this.#client = null;
    const held = this.#active;
    this.#active = false;
    try {
      if (held && !this.#lost) await client.query('select pg_advisory_unlock(1447112257, 1)');
    } finally {
      // Destroy instead of returning a possibly locked/broken session to the general pool.
      client.removeListener('error', this.#connectionLost);
      client.removeListener('end', this.#connectionLost);
      client.on('error', () => { /* a closing broken socket must not emit an unhandled error */ });
      client.release(true);
    }
  }
}
