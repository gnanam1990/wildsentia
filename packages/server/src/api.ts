import Fastify, { type FastifyInstance } from 'fastify';
import { formatWorldTime, seasonAt } from '@vana/shared';
import type { Pool } from './db/pool.js';
import { EventStore } from './db/eventStore.js';
import type { SimHost } from './simHost.js';

export interface ApiDeps {
  host: SimHost;
  pool: Pool;
}

/**
 * Read-only by construction. There is no mutating route, so a client cannot change the world
 * even if it wanted to — the shared-world promise is enforced by the absence of a write path,
 * not by a permission check that could be misconfigured.
 */
export function buildApi({ host, pool }: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const events = new EventStore(pool);

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
        currentGoal: a.currentGoal, alternativeGoal: a.alternativeGoal,
        drives: a.drives, bornAt: a.bornAt, massKg: a.massKg,
      })),
  }));

  app.get<{ Params: { id: string } }>('/animals/:id', async (request, reply) => {
    const agent = host.world.agents.find((a) => a.id === request.params.id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    return agent;
  });

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
