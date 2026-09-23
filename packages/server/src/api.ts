import Fastify, { type FastifyInstance } from 'fastify';
import { RECAP_EVENT_TYPES, SKILL_IDS, formatWorldTime, seasonAt, thoughtFor, type Agent } from '@vana/shared';
import { confidenceOf } from '@vana/sim';
import type { Pool } from './db/pool.js';
import { EventStore } from './db/eventStore.js';
import { LifeStore } from './db/lifeStore.js';
import type { SimHost } from './simHost.js';
import { Narrator } from './narration/narrator.js';

export interface ApiDeps {
  host: SimHost;
  pool: Pool;
  /** Rewords recap lines through the grounding check. Without one, recaps are templates. */
  narrator?: Narrator;
}

/**
 * Read-only by construction. There is no mutating route, so a client cannot change the world
 * even if it wanted to — the shared-world promise is enforced by the absence of a write path,
 * not by a permission check that could be misconfigured.
 */
export function buildApi({ host, pool, narrator }: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const events = new EventStore(pool);
  const life = new LifeStore(pool);

  /** An animal in the running world, or one archived after it was long gone. */
  const findAnimal = async (id: string): Promise<Agent | undefined> =>
    host.world.agents.find((a) => a.id === id)
    ?? host.world.deceased.find((a) => a.id === id)
    ?? (await life.archived(id)) ?? undefined;
  const narration = narrator ?? new Narrator({ pool, rephrase: null, dailyTokenBudget: 0 });

  app.get('/health', async () => ({ ok: true, worldTime: host.world.now() }));

  app.get('/world', async () => {
    const now = host.world.now();
    const population: Record<string, number> = {};
    for (const speciesId of host.world.species.keys()) {
      population[speciesId] = host.world.livingCount(speciesId);
    }
    return {
      worldTime: now,
      formatted: formatWorldTime(now),
      season: seasonAt(now),
      population,
      patches: host.world.patches.length,
      totalNutrients: host.world.totalNutrients(),
    };
  });

  app.get('/animals', async () => ({
    animals: host.world.agents
      .filter((a) => a.alive)
      .map((a) => ({
        id: a.id, speciesId: a.speciesId, patchId: a.patchId, state: a.state,
        currentGoal: a.currentGoal, alternativeGoal: a.alternativeGoal, goalScore: a.goalScore,
        dependent: a.dependentOn !== null,
        drives: a.drives, bornAt: a.bornAt, massKg: a.massKg,
      })),
  }));

  app.get<{ Params: { id: string } }>('/animals/:id', async (request, reply) => {
    const agent = host.world.agents.find((a) => a.id === request.params.id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    return agent;
  });

  /**
   * Everything the passport shows (spec §10.2), read from live state and the event log. No
   * field is authored; the thought is a template over the planner's own state, with the facts
   * it was built from alongside. Works for the dead too: their record outlives them.
   */
  app.get<{ Params: { id: string } }>('/animals/:id/passport', async (request, reply) => {
    const world = host.world;
    const agent = await findAnimal(request.params.id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    const config = world.species.get(agent.speciesId)!;
    const kinOf = async (id: string | null) => {
      const other = id === null ? undefined : await findAnimal(id);
      return other === undefined ? null : { id: other.id, alive: other.alive };
    };
    const [mother, father, ...young] = await Promise.all(
      [agent.motherId, agent.fatherId, ...agent.offspringIds].map((id) => kinOf(id)),
    );

    const timeline = await events.byActor(agent.id, 50);
    // Asked for separately: scavenging a large carcass can push the death past the timeline's end.
    const died = agent.alive ? null : await events.deathOf(agent.id);

    return {
      id: agent.id,
      speciesId: agent.speciesId,
      displayName: config.displayName,
      sex: agent.sex,
      ageDays: agent.ageDays,
      lifeStage: agent.lifeStage,
      generation: agent.generation,
      coatVariant: agent.traits.coatVariant,
      massKg: agent.massKg,
      alive: agent.alive,
      state: agent.state,
      patchId: agent.patchId,
      drives: agent.drives,
      currentGoal: agent.currentGoal,
      alternativeGoal: agent.alternativeGoal,
      thought: agent.alive
        ? thoughtFor({
          state: agent.state, currentGoal: agent.currentGoal, alternativeGoal: agent.alternativeGoal,
          goalScore: agent.goalScore, drives: agent.drives, dependent: agent.dependentOn !== null,
        })
        : null,
      lineage: {
        mother: mother ?? null,
        father: father ?? null,
        offspring: young.filter((k) => k !== null && k !== undefined),
        groupId: agent.groupId ?? null,
      },
      skills: SKILL_IDS
        .filter((skill) => config.learning?.innate[skill] !== undefined)
        .map((skill) => ({
          skill,
          confidence: confidenceOf(agent, config, skill),
          taughtBy: agent.skills?.[skill]?.taughtBy ?? null,
          successes: agent.skills?.[skill]?.successes ?? 0,
          failures: agent.skills?.[skill]?.failures ?? 0,
        })),
      death: died === null
        ? null
        : { cause: String(died.conditions.cause ?? 'unknown'), worldTime: died.worldTime, eventId: died.id },
      timeline: timeline.map((e) => ({
        id: e.id, type: e.type, worldTime: e.worldTime, outcome: e.outcome, actors: e.actors,
      })),
    };
  });

  /**
   * A whole life to replay (spec §11): where the animal was, sampled every few world hours, and
   * every significant thing that happened to it, each tied to its event. Positions between
   * samples are the client's to interpolate; nothing here is invented.
   */
  app.get<{ Params: { id: string } }>('/animals/:id/life', async (request, reply) => {
    const agent = await findAnimal(request.params.id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    const track = await life.trackOf(agent.id);
    if (agent.alive) {
      const now = host.world.now();
      if (track.length === 0 || track[track.length - 1]!.worldTime < now) {
        track.push({
          id: agent.id, worldTime: now, patchId: agent.patchId, state: agent.state,
          goal: agent.currentGoal, drives: agent.drives,
        });
      }
    }
    const major = await events.byActorSince(agent.id, -1, 5000, RECAP_EVENT_TYPES);
    return {
      id: agent.id,
      speciesId: agent.speciesId,
      alive: agent.alive,
      bornAt: agent.bornAt,
      departedAt: agent.departedAt ?? null,
      track: track.map(({ id: _id, ...point }) => point),
      moments: await narration.recap(major, agent.id),
    };
  });

  /**
   * While you were away (spec §10.4): what happened to an animal since `since`, one template
   * line per significant event, each carrying its event id. Routine events are left out.
   */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/animals/:id/recap',
    async (request, reply) => {
      const since = Number(request.query.since);
      if (request.query.since === undefined || !Number.isFinite(since)) {
        return reply.code(400).send({ error: 'since_required' });
      }
      const missed = await events.byActorSince(request.params.id, since, 2000, RECAP_EVENT_TYPES);
      return { since, until: host.world.now(), lines: await narration.recap(missed, request.params.id) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/animals/:id/events',
    async (request) => ({
      events: await events.byActor(request.params.id, Number(request.query.limit ?? 100)),
    }),
  );

  app.get<{ Querystring: { limit?: string } }>('/events', async (request) => ({
    events: await events.recent(Number(request.query.limit ?? 50)),
  }));

  app.get('/patches', async () => ({
    patches: host.world.patches.map((p) => ({
      id: p.id, x: p.x, y: p.y, habitat: p.habitat,
      elevation: p.elevation, canopyCover: p.canopyCover,
      grass: p.plant.grass, browse: p.plant.browse,
      water: p.waterVolume, soilNutrients: p.soilNutrients,
    })),
  }));

  return app;
}
