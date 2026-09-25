import { isCommunityMotion, type CommunityMotion, type CommunityState, type HumanMotionSample } from '@vana/shared';
import type { Database } from './pool.js';

interface MotionRow {
  person_id: string;
  start_world_time: string;
  end_world_time: string;
  samples: HumanMotionSample[];
}
export interface PersonMotionWindow {
  startWorldTime: number;
  endWorldTime: number;
  samples: HumanMotionSample[];
}

export class HumanMotionStore {
  constructor(private readonly db: Database) {}

  async hasAny(): Promise<boolean> {
    const { rows } = await this.db.query<{ present: boolean }>(
      'select exists(select 1 from human_motion) as present',
    );
    return rows[0]?.present === true;
  }

  /** Called only by the lock-owning world writer. A retried checkpoint cannot duplicate a segment. */
  async append(recordings: readonly { community: CommunityState; motion: CommunityMotion }[]): Promise<void> {
    if (recordings.length === 0) return;
    const rows: Array<[string, number, number, string]> = [];
    for (const { community, motion } of recordings) {
      if (!isCommunityMotion(motion, community)) throw new Error('invalid executed human motion');
      for (const track of motion.tracks) rows.push([track.personId, motion.startWorldTime, motion.endWorldTime, JSON.stringify(track.samples)]);
    }
    for (let start = 0; start < rows.length; start += 250) {
      const slice = rows.slice(start, start + 250), values: unknown[] = [];
      const tuples = slice.map((row, i) => {
        values.push(...row);
        const n = i * 4;
        return `($${n + 1},$${n + 2},$${n + 3},$${n + 4}::jsonb)`;
      });
      await this.db.query(`insert into human_motion (person_id, start_world_time, end_world_time, samples)
        values ${tuples.join(',')} on conflict (person_id, start_world_time) do nothing`, values);
    }
  }

  /** Newest-first keyset page pinned to a committed boundary, never a volatile world clock. */
  async page(personId: string, boundaryWorldTime: number, limit: number, beforeStart?: number): Promise<{
    windows: PersonMotionWindow[]; nextBefore: number | null;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 48) throw new Error('invalid human motion limit');
    const { rows } = await this.db.query<MotionRow>(`select person_id, start_world_time, end_world_time, samples
      from human_motion where person_id = $1 and end_world_time <= $2
      and ($3::bigint is null or start_world_time < $3)
      order by start_world_time desc limit $4`, [personId, boundaryWorldTime, beforeStart ?? null, limit + 1]);
    const windows = rows.slice(0, limit).map(r => ({ startWorldTime: Number(r.start_world_time),
      endWorldTime: Number(r.end_world_time), samples: r.samples }));
    return { windows, nextBefore: rows.length > limit ? windows.at(-1)!.startWorldTime : null };
  }

  async deleteAfter(boundaryWorldTime: number): Promise<number> {
    const result = await this.db.query('delete from human_motion where end_world_time > $1', [boundaryWorldTime]);
    return result.rowCount ?? 0;
  }
}
