import { positionInPatch, type WorldEvent, type WorldGrid } from '@vana/shared';
import { isRecordedTreeClimb } from '../liveEncounters.js';
import type { Database } from './pool.js';

export interface EventBoundary { worldTime: number; nextSequence: number }
// Parameter numbers are compile-time call-site constants, never request strings.
const beforeCheckpoint = (time: number, sequence: number): string =>
  `($${time}::bigint is null or world_time < $${time} or (world_time = $${time} and event_sequence < $${sequence}::bigint))`;

interface Row {
  id: string; type: string; world_time: string; sim_version: string; patch_id: number;
  actors: string[]; goal: string | null; conditions: Record<string, number | string>;
  outcome: string; effects: Record<string, number>; causal_parents: string[]; confidence: string;
  encounter: WorldEvent['encounter'] | null;
  movement: WorldEvent['movement'] | null;
  position: WorldEvent['position'] | null;
  has_encounter?: boolean;
  has_climb?: boolean;
}

const toEvent = (grid: WorldGrid, r: Row): WorldEvent => ({
  id: r.id,
  type: r.type as WorldEvent['type'],
  worldTime: Number(r.world_time),
  simVersion: r.sim_version,
  patchId: r.patch_id,
  actors: r.actors,
  ...(r.goal === null ? {} : { goal: r.goal }),
  conditions: r.conditions,
  outcome: r.outcome as WorldEvent['outcome'],
  effects: r.effects,
  causalParents: r.causal_parents,
  confidence: r.confidence as WorldEvent['confidence'],
  ...(r.encounter == null ? {} : { encounter: r.encounter }),
  ...(r.movement == null ? {} : { movement: r.movement }),
  ...(positionInPatch(grid, r.position, r.patch_id) ? { position: { ...r.position } } : {}),
  ...(r.has_encounter === undefined ? {} : { hasEncounter: r.has_encounter }),
  ...(r.has_climb === undefined ? {} : { hasClimb: r.has_climb }),
});

/** Stable EventLog IDs, not caller-authored timestamp order. Null for legacy random IDs. */
export function eventSequence(id: string): number | null {
  if (!/^[a-z_]+_[0-9a-f]{24}$/.test(id)) return null;
  const n = Number.parseInt(id.slice(-16), 16);
  return Number.isSafeInteger(n) ? n : null;
}

export class EventStore {
  /** `grid`: the lattice of the world these events belong to (the island unless told otherwise). */
  constructor(private readonly pool: Database, private readonly grid: WorldGrid) {
    if (!grid) throw new Error('an event store needs the grid of the world it serves');
  }

  /** Primary-key lookup remains actor scoped and checkpoint bounded; guessing an ID cannot
   * expose a volatile event or another animal's encounter. */
  async encounterById(actorId: string, eventId: string, boundary: EventBoundary): Promise<WorldEvent | null> {
    const { rows } = await this.pool.query<Row>(
      `select * from events where id = $1 and type = 'hunt' and actors @> array[$2]::text[]
       and encounter is not null and ${beforeCheckpoint(3, 4)}`,
      [eventId, actorId, boundary.worldTime, boundary.nextSequence],
    );
    const event = rows[0] ? toEvent(this.grid, rows[0]) : null;
    return event?.encounter && [event.encounter.predatorId, event.encounter.preyId].includes(actorId) ? event : null;
  }

  /** Direct retained climb lookup is actor-scoped and bounded by the observed checkpoint. */
  async climbById(actorId: string, eventId: string, boundary: EventBoundary): Promise<WorldEvent | null> {
    const { rows } = await this.pool.query<Row>(
      `select * from events where id = $1 and type = 'tree_climbed' and actors @> array[$2]::text[]
       and movement is not null and ${beforeCheckpoint(3, 4)}`,
      [eventId, actorId, boundary.worldTime, boundary.nextSequence],
    );
    const event = rows[0] ? toEvent(this.grid, rows[0]) : null;
    return event && isRecordedTreeClimb(this.grid, event) && event.movement?.actorId === actorId ? event : null;
  }

  /** Keyset pagination has a total order even for simultaneous events and legacy null sequences.
   * No offset and no moving upper bound: later checkpoints cannot leak into this traversal. */
  async page(options: {
    actorId: string | null; boundary: EventBoundary; limit: number; descending?: boolean;
    after?: { worldTime: number; id: string } | undefined;
    since?: number; sinceSequence?: number | null; types?: readonly string[];
    summary?: boolean; omitMovement?: boolean;
  }): Promise<{ events: WorldEvent[]; after: { worldTime: number; id: string } | null }> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500) throw new Error('invalid history page limit');
    const direction = options.descending ? 'desc' : 'asc', comparison = options.descending ? '<' : '>';
    // A browser list needs a discovery flag, not hundreds of thousands of trajectory samples.
    // Project in SQL so those JSON values do not cross the database/Node boundary either.
    const columns = options.summary ? `id, type, world_time, sim_version, patch_id, actors, goal, conditions,
      outcome, effects, causal_parents, confidence, position, null::jsonb as encounter, null::jsonb as movement,
      (encounter is not null) as has_encounter,
      (type = 'tree_climbed' and movement is not null) as has_climb`
      : options.omitMovement ? `id, type, world_time, sim_version, patch_id, actors, goal, conditions,
        outcome, effects, causal_parents, confidence, position, encounter, null::jsonb as movement` : '*';
    const { rows } = await this.pool.query<Row>(
      `select ${columns} from events where ($1::text is null or actors @> array[$1]::text[])
       and ${beforeCheckpoint(2, 3)}
       and (world_time > $4 or (world_time = $4 and ($5::bigint is null or event_sequence >= $5)))
       and ($6::text[] is null or type = any($6::text[]))
       and ($7::bigint is null or (world_time, id collate "C") ${comparison} ($7::bigint, $8::text collate "C"))
       order by world_time ${direction}, id collate "C" ${direction} limit $9`,
      [options.actorId, options.boundary.worldTime, options.boundary.nextSequence, options.since ?? -1,
        options.sinceSequence ?? null, options.types ?? null, options.after?.worldTime ?? null,
        options.after?.id ?? null, options.limit + 1],
    );
    const events = rows.slice(0, options.limit).map((r) => toEvent(this.grid, r)), last = events.at(-1);
    return { events, after: rows.length > options.limit && last ? { worldTime: last.worldTime, id: last.id } : null };
  }

  async appendBatch(events: readonly WorldEvent[]): Promise<void> {
    if (events.length === 0) return;
    for (const event of events) {
      if (event.position !== undefined && !positionInPatch(this.grid, event.position, event.patchId)) {
        throw new Error('event position must be finite and inside its recorded patch');
      }
    }

    const CHUNK = 500;
    for (let start = 0; start < events.length; start += CHUNK) {
      const slice = events.slice(start, start + CHUNK);
      const values: unknown[] = [];
      const tuples = slice.map((e, i) => {
        const o = i * 16;
        values.push(
          e.id, e.type, e.worldTime, e.simVersion, e.patchId, e.actors,
          e.goal ?? null, JSON.stringify(e.conditions), e.outcome,
          JSON.stringify(e.effects), e.causalParents, e.confidence, e.encounter ? JSON.stringify(e.encounter) : null,
          e.movement ? JSON.stringify(e.movement) : null,
          e.position ? JSON.stringify(e.position) : null,
          eventSequence(e.id),
        );
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},` +
               `$${o + 8}::jsonb,$${o + 9},$${o + 10}::jsonb,$${o + 11},$${o + 12},$${o + 13}::jsonb,$${o + 14}::jsonb,$${o + 15}::jsonb,$${o + 16})`;
      });

      await this.pool.query(
        `insert into events
           (id, type, world_time, sim_version, patch_id, actors, goal, conditions, outcome, effects, causal_parents, confidence, encounter, movement, position, event_sequence)
         values ${tuples.join(',')}
         on conflict (id) do nothing`,
        values,
      );
    }
  }

  async recent(limit: number, boundary?: EventBoundary): Promise<WorldEvent[]> {
    const { rows } = await this.pool.query<Row>(
      `select * from events where ${beforeCheckpoint(2, 3)} order by world_time desc, recorded_at desc limit $1`,
      [limit, boundary?.worldTime ?? null, boundary?.nextSequence ?? null],
    );
    return rows.map((r) => toEvent(this.grid, r));
  }

  async mapEvents(until: number, nextSequence?: number): Promise<WorldEvent[]> {
    const { rows } = await this.pool.query<Row>(
      `select * from events where type in ('hunt', 'human_hunt', 'born', 'human_born', 'died', 'human_died', 'immigration')
       and world_time <= $1 and ($2::bigint is null or world_time < $1 or event_sequence < $2)
       order by world_time desc, id desc limit 100`, [until, nextSequence ?? null],
    );
    return rows.map((r) => toEvent(this.grid, r));
  }

  async byActor(actorId: string, limit: number, boundary?: EventBoundary): Promise<WorldEvent[]> {
    const { rows } = await this.pool.query<Row>(
      `select * from events where $1 = any(actors) and ${beforeCheckpoint(3, 4)} order by world_time desc limit $2`,
      [actorId, limit, boundary?.worldTime ?? null, boundary?.nextSequence ?? null],
    );
    return rows.map((r) => toEvent(this.grid, r));
  }

  /** A bounded village activity view: routine resting must not hide a catch or cooking result. */
  async communityActivity(actorId: string, boundary: EventBoundary): Promise<WorldEvent[]> {
    const { rows } = await this.pool.query<Row>(
      `select * from events where $1 = any(actors) and ${beforeCheckpoint(2, 3)} and (
        type in ('community_founded', 'building_stage', 'building_repaired', 'building_storm', 'building_flooded', 'building_collapsed', 'building_rebuilt', 'building_shelter_changed', 'human_died', 'human_task_interrupted', 'human_cooperated', 'human_skill_learned', 'human_resource_collected', 'human_hunt', 'human_conceived', 'human_born', 'human_pregnancy_lost', 'human_cared')
        or (type in ('human_task_started', 'human_task_finished') and conditions->>'action' in ('fish', 'cook', 'hunt'))
        or (type = 'human_task_finished' and conditions->>'action' = 'deliver'
          and (case when jsonb_typeof(effects->'rawFishKg') = 'number' then (effects->>'rawFishKg')::numeric > 0 else false end
            or case when jsonb_typeof(effects->'rawMeatKg') = 'number' then (effects->>'rawMeatKg')::numeric > 0 else false end))
      ) order by world_time desc, event_sequence desc nulls last, id desc limit 25`,
      [actorId, boundary.worldTime, boundary.nextSequence],
    );
    return rows.map((r) => toEvent(this.grid, r));
  }

  /**
   * An animal's events after `since`, oldest first — what a returning watcher missed. `types`
   * narrows it to the ones worth telling; an animal away a year has a routine event every hour.
   */
  async byActorSince(
    actorId: string,
    since: number,
    limit: number,
    types?: readonly string[],
    boundary?: EventBoundary,
    /** Undefined preserves exclusive legacy queries; null includes the boundary for a time-only viewer cursor. */
    sinceSequence?: number | null,
  ): Promise<WorldEvent[]> {
    const { rows } = await this.pool.query<Row>(
      `select * from events where $1 = any(actors) and (world_time > $2 or
         ($7::boolean and world_time = $2 and ($8::bigint is null or event_sequence >= $8)))
         and ($4::text[] is null or type = any($4::text[]))
         and ${beforeCheckpoint(5, 6)}
       order by world_time asc limit $3`,
      [actorId, since, limit, types ?? null, boundary?.worldTime ?? null, boundary?.nextSequence ?? null,
        sinceSequence !== undefined, sinceSequence ?? null],
    );
    return rows.map((r) => toEvent(this.grid, r));
  }

  /**
   * The event recording an animal's death, however much happened to its carcass afterwards.
   * A death names the dead first and its killer second, so only the first actor counts.
   */
  async deathOf(actorId: string, boundary?: EventBoundary): Promise<WorldEvent | null> {
    const { rows } = await this.pool.query<Row>(
      `select * from events where type = 'died' and actors[1] = $1 and ${beforeCheckpoint(2, 3)} limit 1`,
      [actorId, boundary?.worldTime ?? null, boundary?.nextSequence ?? null],
    );
    return rows.length === 0 ? null : toEvent(this.grid, rows[0]!);
  }

  async countAfter(worldTime: number, nextSequence?: number): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'select count(*) from events where world_time > $1 or (world_time = $1 and event_sequence >= $2::bigint)',
      [worldTime, nextSequence ?? null],
    );
    return Number(rows[0]!.count);
  }

  async deleteAfter(worldTime: number, nextSequence?: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      'delete from events where world_time > $1 or (world_time = $1 and event_sequence >= $2::bigint)',
      [worldTime, nextSequence ?? null]);
    return rowCount ?? 0;
  }

  async total(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>('select count(*) from events');
    return Number(rows[0]!.count);
  }
}
