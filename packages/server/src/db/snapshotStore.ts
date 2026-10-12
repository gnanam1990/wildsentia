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
   * Keeps the last `keep` world times, and at each the newest snapshot of every rules version.
   * Live agents' changes are checkpointed between hours at the same world time, so they must not
   * push out the hourly history; an explicit rules upgrade saves at the same world time too, and
   * the snapshot it upgraded from is kept beside it.
   */
  async prune(keep: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `delete from snapshots where id not in (
         select max(id) from snapshots
         where world_time in (select distinct world_time from snapshots order by world_time desc limit $1)
         group by world_time, sim_version)`,
      [keep],
    );
    return rowCount ?? 0;
  }
}
