import type { WorldEvent } from '@vana/shared';
import type { Pool } from './pool.js';

interface Row {
  id: string; type: string; world_time: string; sim_version: string; patch_id: number;
  actors: string[]; goal: string | null; conditions: Record<string, number | string>;
  outcome: string; effects: Record<string, number>; causal_parents: string[]; confidence: string;
}

const toEvent = (r: Row): WorldEvent => ({
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
});

export class EventStore {
  constructor(private readonly pool: Pool) {}

  async appendBatch(events: readonly WorldEvent[]): Promise<void> {
    if (events.length === 0) return;

    const CHUNK = 500;
    for (let start = 0; start < events.length; start += CHUNK) {
      const slice = events.slice(start, start + CHUNK);
      const values: unknown[] = [];
      const tuples = slice.map((e, i) => {
        const o = i * 12;
        values.push(
          e.id, e.type, e.worldTime, e.simVersion, e.patchId, e.actors,
          e.goal ?? null, JSON.stringify(e.conditions), e.outcome,
          JSON.stringify(e.effects), e.causalParents, e.confidence,
        );
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},` +
               `$${o + 8}::jsonb,$${o + 9},$${o + 10}::jsonb,$${o + 11},$${o + 12})`;
      });

      await this.pool.query(
        `insert into events
           (id, type, world_time, sim_version, patch_id, actors, goal, conditions, outcome, effects, causal_parents, confidence)
         values ${tuples.join(',')}
         on conflict (id) do nothing`,
        values,
      );
    }
  }

  async recent(limit: number): Promise<WorldEvent[]> {
    const { rows } = await this.pool.query<Row>(
      'select * from events order by world_time desc, recorded_at desc limit $1', [limit],
    );
    return rows.map(toEvent);
  }

  async byActor(actorId: string, limit: number): Promise<WorldEvent[]> {
    const { rows } = await this.pool.query<Row>(
      'select * from events where $1 = any(actors) order by world_time desc limit $2',
      [actorId, limit],
    );
    return rows.map(toEvent);
  }

  /**
   * The event recording an animal's death, however much happened to its carcass afterwards.
   * A death names the dead first and its killer second, so only the first actor counts.
   */
  async deathOf(actorId: string): Promise<WorldEvent | null> {
    const { rows } = await this.pool.query<Row>(
      "select * from events where type = 'died' and actors[1] = $1 limit 1", [actorId],
    );
    return rows.length === 0 ? null : toEvent(rows[0]!);
  }

  async countAfter(worldTime: number): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'select count(*) from events where world_time > $1', [worldTime],
    );
    return Number(rows[0]!.count);
  }

  async deleteAfter(worldTime: number): Promise<number> {
    const { rowCount } = await this.pool.query('delete from events where world_time > $1', [worldTime]);
    return rowCount ?? 0;
  }

  async total(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>('select count(*) from events');
    return Number(rows[0]!.count);
  }
}
