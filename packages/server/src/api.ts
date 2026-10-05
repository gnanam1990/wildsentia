import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { RECAP_EVENT_TYPES, SKILL_IDS, formatWorldTime, seasonAt, thoughtFor, type Agent } from '@vana/shared';
import { confidenceOf } from '@vana/sim';
import type { Pool } from './db/pool.js';
import { EventStore } from './db/eventStore.js';
import { LifeStore } from './db/lifeStore.js';
import { HumanMotionStore } from './db/humanMotionStore.js';
import type { CheckpointObservation, SimHost } from './simHost.js';
import { Narrator } from './narration/narrator.js';
import { eventMarker } from './eventMap.js';
import { installRewards, type RewardConfig } from './rewards.js';
import type { ReceiptRpc } from './baseReceipt.js';
import { installSocialOutbox, type SocialConfig } from './socialOutbox.js';
import { HistoryCursors, historyLimit } from './historyCursor.js';
import { floweringGuildSummary } from './floweringObservation.js';
import { installHolder, type HolderChain, type HolderConfig } from './holder.js';
import { Insights } from './insights/insights.js';
import { installLiveAgents, type LiveRouteDeps } from './live/routes.js';
import type { PlaceDropLedger } from './live/liveStore.js';

export interface ApiDeps {
  host: SimHost;
  pool: Pool;
  /** Rewords recap lines through the grounding check. Without one, recaps are templates. */
  narrator?: Narrator;
  /** Outside agents steering animals (docs/2026-09-26-live-agents-design.md); absent unless enabled. */
  live?: (LiveRouteDeps & { spot: () => { x: number; z: number } | null }) | undefined;
  /** Observer insights (TypeSafe AI); absent insights are reported as not configured. */
  insights?: Insights;
  rewards?: RewardConfig | undefined;
  receiptRpc?: ReceiptRpc;
  social?: SocialConfig | undefined;
  holder?: HolderConfig | undefined;
  holderChain?: HolderChain;
  /**
   * Reverse proxies in front of the server whose X-Forwarded-For entries are trusted, so
   * per-visitor limits see the visitor rather than the proxy. 0 (default) trusts none.
   */
  trustedProxyHops?: number;
}

/** VANA_TRUSTED_PROXY_HOPS: how many proxies (e.g. 1 for Caddy in deploy/) to trust. */
export function trustedProxyHops(env: NodeJS.ProcessEnv): number {
  const value = env.VANA_TRUSTED_PROXY_HOPS;
  if (value === undefined || value === '') return 0;
  if (!/^[0-9]$/.test(value)) throw new Error('Invalid VANA_TRUSTED_PROXY_HOPS');
  return Number(value);
}

/**
 * World routes are read-only. The optional reward ledger has independent write routes and
 * receives only a read-only subject visibility adapter, never a simulation mutation capability.
 */
export function buildApi({ host, pool, narrator, insights: insightDeps, live, rewards, receiptRpc, social, holder, holderChain, trustedProxyHops: hops = 0 }: ApiDeps): FastifyInstance {
  // Without this, behind Caddy every visitor has the proxy's address and shares one rate limit.
  const app = Fastify({ logger: false, trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false });
  // An unexpected failure's message can name database hosts, tables and constraints: log it
  // here and send a plain error. Client mistakes (bad JSON, too large) keep Fastify's reply.
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if ((error.statusCode ?? 500) < 500) return reply.send(error);
    console.error('[api] request failed', error);
    return reply.code(500).send({ error: 'internal_error' });
  });
  const events = new EventStore(pool);
  const life = new LifeStore(pool);
  const humanMotion = new HumanMotionStore(pool);
  const historyCursors = new HistoryCursors();
  installRewards(app, { pool, config: rewards, ...(receiptRpc ? { receiptRpc } : {}), subject: (id) => host.rewardSubject(id), world: () => host.worldId,
    ...(live?.ledger ? { placeDrops: { ledger: live.ledger as PlaceDropLedger, spot: live.spot } } : {}),
    ...(live ? { agents: { mute: async (idOrName: string, muted: boolean) => {
      const id = await live.store.setMuted(idOrName, muted);
      if (id && muted) live.live.forgetSaid(id);
      return id;
    } } } : {}) });
  if (live) installLiveAgents(app, live);
  installSocialOutbox(app, { pool, config: social, boundary: () => {
    const view = host.observation();
    return view ? { worldTime: view.worldTime, nextSequence: view.nextSequence } : null;
  } });
  installHolder(app, { pool, config: holder, ...(holderChain ? { chain: holderChain } : {}), boundary: () => {
    const view = host.observation();
    return view ? { worldTime: view.worldTime, nextSequence: view.nextSequence } : null;
  } });

  const observationRoutes = new Set(['/world', '/animals', '/animals/:id', '/patches', '/hydrology', '/carcasses', '/event-map', '/animals/:id/passport', '/animals/:id/life', '/animals/:id/encounters/:eventId', '/animals/:id/movements/:eventId', '/animals/:id/recap', '/animals/:id/events', '/events']);
  const observations = new WeakMap<FastifyRequest, CheckpointObservation>();
  observationRoutes.add('/community');
  observationRoutes.add('/people/:id');
  observationRoutes.add('/people/:id/events');
  observationRoutes.add('/people/:id/motion');
  observationRoutes.add('/insights/animals/:id/outlook');
  observationRoutes.add('/insights/highlights');
  app.addHook('preHandler', async (request, reply) => {
    if (!observationRoutes.has(request.routeOptions.url ?? '')) return;
    reply.header('Cache-Control', 'no-store');
    const view = host.observation();
    if (view === null) return reply.code(503).send({ error: 'checkpoint_history_unavailable' });
    observations.set(request, view);
  });
  const observed = (request: FastifyRequest): CheckpointObservation => observations.get(request)!;
  /** One request pins one committed animal view and boundary across every awaited query. */
  const findAnimal = async (id: string, view: CheckpointObservation): Promise<Agent | undefined> => {
    const saved = view.animal(id);
    if (saved) return saved;
    const archived = await life.archived(id, view.worldTime);
    if (!archived) return undefined;
    // With aggressive archival, an unsaved death can reach the archive at the checkpoint's
    // exact time too. Require its committed departure record rather than trusting time alone.
    if (archived.departedAt === view.worldTime) {
      const departures = await events.byActorSince(id, view.worldTime - 1, 10, ['died', 'emigration'], view);
      if (!departures.some((e) => e.actors[0] === id && e.worldTime === archived.departedAt)) return undefined;
    }
    return archived;
  };
  const narration = narrator ?? new Narrator({ pool, rephrase: null, dailyTokenBudget: 0 });

  app.get('/health', async (_request, reply) => {
    const ok = host.isWriterActive && host.lastError === null && host.hasFreshCheckpoint;
    if (!ok) reply.code(503);
    // The uptime monitor must measure saved progress, not an in-flight hour that can
    // disappear if the writer dies before its checkpoint commits.
    return { ok, worldTime: host.checkpointTime };
  });

  app.get('/event-map', async (request) => {
    const view = observed(request);
    return { worldTime: view.worldTime, markers: (await events.mapEvents(view.worldTime, view.nextSequence))
      .map(eventMarker).filter((marker) => marker !== null),
    notice: 'Recent recorded events, not live alerts. Events without valid recorded positions use approximate patch centres.' };
  });

  app.get('/world', async (request) => {
    const view = observed(request), now = view.worldTime;
    return {
      source: 'checkpoint', nextEventSequence: view.nextSequence,
      worldTime: now,
      formatted: formatWorldTime(now),
      season: seasonAt(now),
      ...view.summary(),
      worldHoursPerRealHour: host.worldHoursPerRealHour,
    };
  });

  app.get('/community', async (request) => {
    const view = observed(request), community = view.community();
    return { source: 'checkpoint', asOfWorldTime: view.worldTime, nextEventSequence: view.nextSequence,
      community, events: community ? await events.communityActivity(community.id, view) : [],
      notice: 'Checkpointed fictional autonomous household. Later rules add human hunting, a bounded family lifecycle, and local storm/flood damage with material-paid rebuilding. Distant stock is not known remotely. The settlement is not yet a complete multi-house village or culturally grounded depiction.' };
  });

  app.get<{ Params: { id: string } }>('/people/:id', async (request, reply) => {
    const view = observed(request), community = view.community(), person = community?.people.find(p => p.id === request.params.id);
    if (!person) return reply.code(404).send({ error: 'person_not_found' });
    return { source: 'checkpoint', asOfWorldTime: view.worldTime, nextEventSequence: view.nextSequence,
      person, relationships: community?.relationships?.filter(r => r.members.includes(person.id)) ?? [],
      events: await events.byActor(person.id, 50, view) };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>('/people/:id/events', async (request, reply) => {
    const view = observed(request), id = request.params.id;
    if (!view.community()?.people.some(p => p.id === id)) return reply.code(404).send({ error: 'person_not_found' });
    const limit = historyLimit(request.query.limit, 25);
    if (limit === null) return reply.code(400).send({ error: 'invalid_limit' });
    const result = await historyPage(id, request.query.cursor, limit, view, true, 'person-history:');
    return result ? { ...result, personId: id,
      retention: 'Recorded events involving this person, newest first. Older routine tasks may be pruned; significant resource collection, hunting, learning, cooperation, construction, repair, family care, birth and death records remain. Founders have no invented birth or pre-founding biography. This is event history, not animation replay.' }
      : reply.code(400).send({ error: 'invalid_history_cursor', restart: true });
  });

  /** Only executed and checkpointed human movement. Missing hours, including legacy data,
   * are absent records and must never be extrapolated by the observer. */
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>('/people/:id/motion', async (request, reply) => {
    const view = observed(request), id = request.params.id;
    if (!view.community()?.people.some(p => p.id === id)) return reply.code(404).send({ error: 'person_not_found' });
    const limit = historyLimit(request.query.limit, 24);
    if (limit === null || limit > 48) return reply.code(400).send({ error: 'invalid_limit' });
    const scope = `human-motion:${id}`;
    const cursor = request.query.cursor === undefined ? null : historyCursors.decode(request.query.cursor, scope, view);
    if (request.query.cursor !== undefined && (!cursor || cursor.after?.id !== undefined && cursor.after.id !== id))
      return reply.code(400).send({ error: 'invalid_motion_cursor', restart: true });
    const boundary = cursor?.boundary ?? { worldTime: view.worldTime, nextSequence: view.nextSequence };
    const beforeStart = cursor?.after?.worldTime;
    const page = await humanMotion.page(id, boundary.worldTime, limit, beforeStart);
    const pageCursor = historyCursors.encode({ version: 1, scope, boundary,
      after: beforeStart === undefined ? null : { worldTime: beforeStart, id }, since: 0, sinceSequence: null });
    const nextCursor = page.nextBefore === null ? null : historyCursors.encode({ version: 1, scope, boundary,
      after: { worldTime: page.nextBefore, id }, since: 0, sinceSequence: null });
    return { source: 'checkpoint', personId: id, asOfWorldTime: boundary.worldTime, nextEventSequence: boundary.nextSequence,
      windows: page.windows, pageCursor, nextCursor,
      retention: 'Executed hourly person-specific samples saved at durable checkpoints. No motion is reconstructed across missing hours or from legacy snapshots. Rows are retained until an explicit migration or retention policy changes that contract.' };
  });

  app.get('/animals', async (request) => ({
    worldTime: observed(request).worldTime, source: 'checkpoint',
    animals: observed(request).livingAnimals()
      .map((a) => ({
        id: a.id, speciesId: a.speciesId, patchId: a.patchId, state: a.state,
        position: a.position,
        ...(a.altitudeM === undefined ? {} : { altitudeM: a.altitudeM, locomotionMode: a.locomotionMode ?? 'flight' }),
        currentGoal: a.currentGoal, alternativeGoal: a.alternativeGoal, goalScore: a.goalScore,
        ...(a.illness?.phase === 'active' ? { illnessStatus: 'symptomatic' } : {}),
        ...(a.wound ? { woundStatus: a.wound.phase } : {}),
        dependent: a.dependentOn !== null,
        drives: a.drives, bornAt: a.bornAt, massKg: a.massKg,
      })),
  }));

  app.get<{ Params: { id: string } }>('/animals/:id', async (request, reply) => {
    const agent = observed(request).animal(request.params.id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    return agent;
  });

  /**
   * Everything the passport shows (spec §10.2), read from checkpoint state and its event log. No
   * field is authored; the thought is a template over the planner's own state, with the facts
   * it was built from alongside. Works for the dead too: their record outlives them.
   */
  app.get<{ Params: { id: string } }>('/animals/:id/passport', async (request, reply) => {
    const world = host.world;
    const view = observed(request);
    const agent = await findAnimal(request.params.id, view);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    const config = world.species.get(agent.speciesId)!;
    const kinOf = async (id: string | null) => {
      const other = id === null ? undefined : await findAnimal(id, view);
      return other === undefined ? null : { id: other.id, alive: other.alive };
    };
    const [mother, father, ...young] = await Promise.all(
      [agent.motherId, agent.fatherId, ...agent.offspringIds].map((id) => kinOf(id)),
    );

    const timeline = await events.byActor(agent.id, 50, view);
    // Asked for separately: scavenging a large carcass can push the death past the timeline's end.
    const died = agent.alive ? null : await events.deathOf(agent.id, view);

    return {
      asOfWorldTime: view.worldTime, nextEventSequence: view.nextSequence, source: 'checkpoint',
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
      ...(agent.alive && agent.illness?.phase === 'active' ? { illnessStatus: 'symptomatic' } : {}),
      ...(agent.alive && agent.wound ? { woundStatus: agent.wound.phase } : {}),
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

  /** A selected recording does not need a full biography scan or other recordings' geometry. */
  app.get<{ Params: { id: string; eventId: string } }>('/animals/:id/encounters/:eventId', async (request, reply) => {
    const view = observed(request), { id, eventId } = request.params;
    const event = await events.encounterById(id, eventId, view);
    if (!event) return reply.code(404).send({ error: 'recording_not_found' });
    const agent = await findAnimal(id, view);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    return { source: 'checkpoint', scope: 'encounter', asOfWorldTime: view.worldTime, nextEventSequence: view.nextSequence,
      id, speciesId: agent.speciesId, alive: agent.alive, bornAt: agent.bornAt, departedAt: agent.departedAt ?? null,
      encounter: { eventId: event.id, outcome: event.outcome, trace: event.encounter,
        predatorSpecies: event.conditions.predatorSpecies, preySpecies: event.conditions.preySpecies } };
  });

  /** An explicitly selected saved tree route, never a reconstruction from sparse life tracks. */
  app.get<{ Params: { id: string; eventId: string } }>('/animals/:id/movements/:eventId', async (request, reply) => {
    const view = observed(request), { id, eventId } = request.params;
    const event = await events.climbById(id, eventId, view);
    if (!event) return reply.code(404).send({ error: 'recording_not_found' });
    const agent = await findAnimal(id, view);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    return { source: 'checkpoint', scope: 'movement', asOfWorldTime: view.worldTime, nextEventSequence: view.nextSequence,
      id, speciesId: agent.speciesId, alive: agent.alive, bornAt: agent.bornAt, departedAt: agent.departedAt ?? null,
      movement: { eventId: event.id, outcome: event.outcome, trace: event.movement,
        direction: event.conditions.direction, reason: event.conditions.reason,
        treeAnchorId: event.conditions.treeAnchorId, verticalDistanceM: event.effects.verticalDistanceM } };
  });

  /**
   * A whole life to replay (spec §11): where the animal was, sampled every few world hours, and
   * every significant thing that happened to it, each tied to its event. Positions between
   * samples are the client's to interpolate; nothing here is invented.
   */
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>('/animals/:id/life', async (request, reply) => {
    const view = observed(request);
    const scope = `life:${request.params.id}`, raw = request.query.cursor;
    const cursor = raw === undefined ? null : historyCursors.decode(raw, scope, view);
    if (raw !== undefined && !cursor) return reply.code(400).send({ error: 'invalid_history_cursor', restart: true });
    const boundary = cursor?.boundary ?? { worldTime: view.worldTime, nextSequence: view.nextSequence };
    const page = await events.page({ actorId: request.params.id, boundary, limit: 32,
      types: RECAP_EVENT_TYPES, after: cursor?.after ?? undefined, omitMovement: true });
    const pageData = {
      asOfWorldTime: boundary.worldTime, nextEventSequence: boundary.nextSequence, source: 'checkpoint', id: request.params.id,
      nextCursor: page.after ? historyCursors.encode({ version: 1, scope, boundary, since: -1, sinceSequence: null, after: page.after }) : null,
      moments: await narration.recap(page.events, request.params.id),
      encounters: page.events.filter((e) => e.encounter !== undefined).map((e) => ({
        eventId: e.id, outcome: e.outcome, trace: e.encounter,
        predatorSpecies: e.conditions.predatorSpecies, preySpecies: e.conditions.preySpecies,
      })),
    };
    // Continuations carry only immutable event pages. Never attach a newer animal/track view
    // to the first page's pinned biography, including if the animal has since died/archived.
    if (cursor) return pageData;
    const agent = await findAnimal(request.params.id, view);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    const track = await life.trackOf(agent.id, 2000, view.worldTime);
    if (agent.alive) {
      const now = view.worldTime;
      if (track.length === 0 || track[track.length - 1]!.worldTime < now) {
        track.push({
          id: agent.id, worldTime: now, patchId: agent.patchId, state: agent.state,
          goal: agent.currentGoal, drives: agent.drives,
          position: agent.position,
        });
      }
    }
    return {
      ...pageData,
      speciesId: agent.speciesId,
      alive: agent.alive,
      bornAt: agent.bornAt,
      departedAt: agent.departedAt ?? null,
      track: track.map(({ id: _id, ...point }) => point),
    };
  });

  /**
   * While you were away (spec §10.4): what happened to an animal since `since`, one template
   * line per significant event, each carrying its event id. Routine events are left out.
   */
  app.get<{ Params: { id: string }; Querystring: { since?: string; sinceSequence?: string; cursor?: string } }>(
    '/animals/:id/recap',
    async (request, reply) => {
      const view = observed(request), scope = `recap:${request.params.id}`;
      const cursor = request.query.cursor === undefined ? null : historyCursors.decode(request.query.cursor, scope, view);
      if (request.query.cursor !== undefined && (!cursor || request.query.since !== undefined || request.query.sinceSequence !== undefined))
        return reply.code(400).send({ error: 'invalid_history_cursor', restart: true });
      const since = cursor?.since ?? Number(request.query.since);
      if (!Number.isSafeInteger(since) || since < -1) {
        return reply.code(400).send({ error: 'since_required' });
      }
      const rawSequence = request.query.sinceSequence;
      const sinceSequence = cursor?.sinceSequence ?? (rawSequence === undefined ? null : Number(rawSequence));
      if (rawSequence !== undefined && (!/^\d+$/.test(rawSequence) || !Number.isSafeInteger(sinceSequence)))
        return reply.code(400).send({ error: 'invalid_since_sequence' });
      const boundary = cursor?.boundary ?? { worldTime: view.worldTime, nextSequence: view.nextSequence };
      const page = await events.page({ actorId: request.params.id, boundary, since, sinceSequence,
        limit: 200, types: RECAP_EVENT_TYPES, after: cursor?.after ?? undefined, omitMovement: true });
      return { since, until: boundary.worldTime, nextEventSequence: boundary.nextSequence,
        nextCursor: page.after ? historyCursors.encode({ version: 1, scope, boundary, since, sinceSequence, after: page.after }) : null,
        source: 'checkpoint', lines: await narration.recap(page.events, request.params.id) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string; view?: string } }>(
    '/animals/:id/events',
    async (request, reply) => {
      const limit = historyLimit(request.query.limit, 100);
      if (limit === null) return reply.code(400).send({ error: 'invalid_limit' });
      if (request.query.view !== undefined && request.query.view !== 'summary') return reply.code(400).send({ error: 'invalid_view' });
      const result = await historyPage(request.params.id, request.query.cursor, limit, observed(request), request.query.view === 'summary');
      return result ?? reply.code(400).send({ error: 'invalid_history_cursor', restart: true });
    },
  );

  async function historyPage(actorId: string | null, raw: string | undefined, limit: number, view: CheckpointObservation, summary = false, namespace = '') {
    const scope = `${namespace}${summary ? 'summary:' : ''}${actorId === null ? 'feed' : `events:${actorId}`}`;
    const cursor = raw === undefined ? null : historyCursors.decode(raw, scope, view);
    if (raw !== undefined && !cursor) return null;
    const boundary = cursor?.boundary ?? { worldTime: view.worldTime, nextSequence: view.nextSequence };
    const page = await events.page({ actorId, boundary, limit, descending: true, after: cursor?.after ?? undefined, summary });
    return { asOfWorldTime: boundary.worldTime, nextEventSequence: boundary.nextSequence, source: 'checkpoint', events: page.events,
      pageCursor: raw ?? historyCursors.encode({ version: 1, scope, boundary, since: -1, sinceSequence: null, after: null }),
      nextCursor: page.after ? historyCursors.encode({ version: 1, scope, boundary, since: -1, sinceSequence: null, after: page.after }) : null,
      retention: 'Retained events only. Older routine feeding, drinking and movement events are pruned; significant life events remain.' };
  }
  app.get<{ Querystring: { limit?: string; cursor?: string; until?: string } }>('/events', async (request, reply) => {
    const limit = historyLimit(request.query.limit, 50);
    if (limit === null) return reply.code(400).send({ error: 'invalid_limit' });
    // The live feed: the newest events up to the hour being played on screen, which runs
    // behind the newest saved hour. A plain newest-first page, without history cursors.
    if (request.query.until !== undefined) {
      if (request.query.cursor !== undefined || !/^[0-9]{1,15}$/.test(request.query.until)) return reply.code(400).send({ error: 'invalid_until' });
      const view = observed(request), until = Math.min(Number(request.query.until), view.worldTime);
      const page = await events.page({ actorId: null, boundary: { worldTime: view.worldTime, nextSequence: view.nextSequence },
        limit, descending: true, after: { worldTime: until + 1, id: '' } });
      return { asOfWorldTime: view.worldTime, nextEventSequence: view.nextSequence, source: 'checkpoint', until, events: page.events };
    }
    return await historyPage(null, request.query.cursor, limit, observed(request))
      ?? reply.code(400).send({ error: 'invalid_history_cursor', restart: true });
  });

  // Observer insights: estimates from TypeSafe AI's Jev about saved state, shown to viewers
  // and never read by the simulation. Absent unless a key is configured.
  const insights = insightDeps ?? new Insights(null);
  const speciesFacts = (id: string) => {
    const config = host.world.species.get(id);
    return { displayName: config?.displayName ?? id, hunts: config?.hunting !== undefined, scavenges: config?.diet.canScavenge ?? false };
  };
  const INSIGHT_NOTICE = 'An estimate by TypeSafe AI (Jev) from saved checkpoint state. The simulation decides what actually happens.';
  app.get<{ Params: { id: string } }>('/insights/animals/:id/outlook', async (request, reply) => {
    if (!insights.configured) return { available: false, reason: 'not_configured' };
    const view = observed(request), agent = view.animal(request.params.id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    const patch = view.patches().find((p) => p.id === agent.patchId);
    const result = await insights.outlook(agent, speciesFacts(agent.speciesId), view.worldTime,
      patch && { habitat: patch.habitat, waterVolume: patch.waterVolume, grass: patch.plant.grass });
    return result.ok ? { available: true, ...result.value, notice: INSIGHT_NOTICE } : { available: false, reason: result.reason };
  });
  app.get('/insights/highlights', async (request) => {
    const view = observed(request);
    if (!insights.configured) return { available: false, reason: 'not_configured' };
    // Candidates are the life events of the past world-day (hunts, births, deaths, illness,
    // climbs...); the latest few hundred records are nearly all drinking and grazing.
    const page = await events.page({ actorId: null, boundary: { worldTime: view.worldTime, nextSequence: view.nextSequence },
      limit: 60, descending: true, summary: true, since: view.worldTime - 86_400, types: RECAP_EVENT_TYPES });
    const result = await insights.highlights(page.events, view.worldTime, view.nextSequence, (id) => speciesFacts(id).displayName);
    return result.ok ? { available: true, ...result.value, notice: INSIGHT_NOTICE } : { available: false, reason: result.reason };
  });

  app.get('/patches', async (request) => ({
    worldTime: observed(request).worldTime, source: 'checkpoint',
    patches: observed(request).patches().map((p) => ({
      id: p.id, x: p.x, y: p.y, habitat: p.habitat,
      elevation: p.elevation, canopyCover: p.canopyCover,
      islandSeed: p.islandSeed, surface: p.surface,
      grass: p.plant.grass, browse: p.plant.browse,
      floweringGuild: floweringGuildSummary(p),
      water: p.waterVolume, soilNutrients: p.soilNutrients, drainage: p.drainage,
    })),
  }));

  app.get('/hydrology', async (request) => {
    const view = observed(request), patches = view.patches(), budget = view.waterBudget();
    const storedL = patches.reduce((sum, patch) => sum + patch.waterVolume, 0);
    return { worldTime: view.worldTime, source: 'checkpoint', scope: 'surface_freshwater',
      budget, storedL, residualL: budget ? budget.initialL + budget.rainfallL + budget.groundwaterL
        - budget.evaporatedL - budget.boundaryOutflowL - budget.animalConsumptionL - (budget.communityWithdrawalL ?? 0) - storedL : null };
  });

  app.get('/micro-ecology', async (request) => {
    const view = observed(request);
    return { worldTime: view.worldTime, source: 'checkpoint', ecology: view.microEcology() };
  });

  app.get('/carcasses', async (request) => ({
    worldTime: observed(request).worldTime, source: 'checkpoint',
    carcasses: observed(request).carcasses().map((c) => ({
      id: c.id, originId: c.originId, speciesId: c.speciesId, patchId: c.patchId,
      position: c.position,
      diedAt: c.diedAt, decayStage: c.decayStage,
      sizeRatio: c.originalMassKg / (host.world.species.get(c.speciesId)?.body.adultMassKg ?? c.originalMassKg),
    })),
  }));

  return app;
}
