import type { Agent, Drives } from '@vana/shared';
import type { Pool } from './pool.js';

/**
 * The hour-by-hour events: kept for the live feed and a recent timeline, then pruned. At the
 * live pace they are over two million a real day, ninety-eight percent of the log; the life
 * story is carried by the events that remain and by the track.
 */
export const ROUTINE_EVENT_TYPES = [
  'moved', 'fed', 'drank', 'rested', 'goal_selected', 'carcass_stage', 'nutrients_returned',
  'scavenged',
] as const;

export interface TrackPoint {
  id: string;
  worldTime: number;
  patchId: number;
  state: string;
  goal: string;
  drives: Drives;
}

interface TrackRow {
  world_time: string; patch_id: number; state: string; goal: string;
  hunger: number; thirst: number; fatigue: number; fear: number;
}

/** Where animals were, and the records of those long gone. */
export class LifeStore {
  constructor(private readonly pool: Pool) {}

  async appendTracks(points: readonly TrackPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.pool.query(
      `insert into tracks (actor_id, world_time, patch_id, state, goal, hunger, thirst, fatigue, fear)
       select * from unnest($1::text[], $2::bigint[], $3::int[], $4::text[], $5::text[],
                            $6::real[], $7::real[], $8::real[], $9::real[])
       on conflict do nothing`,
      [
        points.map((p) => p.id), points.map((p) => p.worldTime), points.map((p) => p.patchId),
        points.map((p) => p.state), points.map((p) => p.goal),
        points.map((p) => p.drives.hunger), points.map((p) => p.drives.thirst),
        points.map((p) => p.drives.fatigue), points.map((p) => p.drives.fear),
      ],
    );
  }

  /**
   * An animal's track, thinned evenly to at most `maxPoints` (plus its last) so a long life does
   * not come back as tens of megabytes. The first and last samples are always kept.
   */
  async trackOf(actorId: string, maxPoints = 2000): Promise<TrackPoint[]> {
    const { rows } = await this.pool.query<TrackRow>(
      `select world_time, patch_id, state, goal, hunger, thirst, fatigue, fear from (
         select *, row_number() over (order by world_time) as rn, count(*) over () as total
         from tracks where actor_id = $1
       ) sampled
       where total <= $2 or (rn - 1) % ceil(total::numeric / $2)::int = 0 or rn = total
       order by world_time asc`,
      [actorId, maxPoints],
    );
    return rows.map((r) => ({
      id: actorId, worldTime: Number(r.world_time), patchId: r.patch_id, state: r.state, goal: r.goal,
      drives: { hunger: r.hunger, thirst: r.thirst, fatigue: r.fatigue, fear: r.fear },
    }));
  }

  /**
   * Keeps the tracks table from growing without end: samples older than `dailyAfterDays` are
   * thinned to one a world day, and older than `weeklyAfterDays` to one a world week.
   */
  async thinTracks(now: number, dailyAfterDays: number, weeklyAfterDays: number): Promise<void> {
    const day = 86_400;
    await this.pool.query(
      'delete from tracks where world_time < $1 and world_time % $2 <> 0',
      [now - dailyAfterDays * day, day],
    );
    await this.pool.query(
      'delete from tracks where world_time < $1 and world_time % $2 <> 0',
      [now - weeklyAfterDays * day, 7 * day],
    );
  }

  /** Samples written after a restart's snapshot belong to a timeline that did not survive. */
  async deleteTracksAfter(worldTime: number): Promise<void> {
    await this.pool.query('delete from tracks where world_time > $1', [worldTime]);
  }

  /** Deletes routine events older than `before`. Returns how many went. */
  async pruneRoutine(before: number): Promise<number> {
    const result = await this.pool.query(
      'delete from events where world_time < $1 and type = any($2::text[])',
      [before, ROUTINE_EVENT_TYPES],
    );
    return result.rowCount ?? 0;
  }

  async archive(agents: readonly Agent[]): Promise<void> {
    if (agents.length === 0) return;
    await this.pool.query(
      `insert into animal_archive (id, species_id, departed_at, record)
       select * from unnest($1::text[], $2::text[], $3::bigint[], $4::jsonb[])
       on conflict (id) do nothing`,
      [
        agents.map((a) => a.id), agents.map((a) => a.speciesId),
        agents.map((a) => a.departedAt ?? 0), agents.map((a) => JSON.stringify(a)),
      ],
    );
  }

  async archived(id: string): Promise<Agent | null> {
    const { rows } = await this.pool.query<{ record: Agent }>(
      'select record from animal_archive where id = $1', [id],
    );
    return rows[0]?.record ?? null;
  }
}
