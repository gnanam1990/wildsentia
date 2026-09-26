import type { Snapshot } from '@vana/sim';
import type { Database } from './pool.js';

export class SnapshotStore {
  constructor(private readonly pool: Database) {}

  async save(snapshot: Snapshot): Promise<void> {
    await this.pool.query(
      'insert into snapshots (world_time, sim_version, payload) values ($1, $2, $3::jsonb)',
      [snapshot.worldTime, snapshot.simVersion, JSON.stringify(snapshot)],
    );
  }

  async loadLatest(): Promise<Snapshot | null> {
    const { rows } = await this.pool.query<{ payload: Snapshot }>(
      'select payload from snapshots order by world_time desc, id desc limit 1',
    );
    return rows[0]?.payload ?? null;
  }

  /**
   * Keeps the newest snapshot of each of the last `keep` world times. Live agents' changes are
   * checkpointed between hours at the same world time; those must not push out the hourly history.
   */
  async prune(keep: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `delete from snapshots where id not in (
         select max(id) from snapshots group by world_time order by world_time desc limit $1)`,
      [keep],
    );
    return rowCount ?? 0;
  }
}
