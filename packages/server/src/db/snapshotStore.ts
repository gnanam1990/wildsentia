import type { Snapshot } from '@vana/sim';
import type { Pool } from './pool.js';

export class SnapshotStore {
  constructor(private readonly pool: Pool) {}

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

  async prune(keep: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `delete from snapshots where id not in (
         select id from snapshots order by world_time desc, id desc limit $1)`,
      [keep],
    );
    return rowCount ?? 0;
  }
}
