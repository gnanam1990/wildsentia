import { createHash, randomBytes } from "node:crypto";
import {
  AccessToken,
  RoomServiceClient,
  AgentDispatchClient,
  TrackSource,
} from "livekit-server-sdk";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  arenaCommand,
  labRequest,
  leagueRequest,
  type FollowedLife,
} from "@vana/shared";
import { cookie, cookieHeader, cookieName } from "../accounts/cookies.js";
import { networkKey } from "../network.js";
import { NetworkRateLimit } from "../limits.js";
import { EventStore, eventSequence } from "../db/eventStore.js";
import type { ExperienceService } from "./service.js";
import { forestMoment, MOMENT_TYPES, safariAnswer } from "./moments.js";
const uuid = (s: string) =>
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s);
const animalId = (s: unknown): s is string =>
  typeof s === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(s);
const body = (r: FastifyRequest): Record<string, unknown> =>
  r.body && typeof r.body === "object" && !Array.isArray(r.body)
    ? (r.body as Record<string, unknown>)
    : {};
export function installExperiences(
  app: FastifyInstance,
  service: ExperienceService,
): void {
  const { config, store, host } = service,
    events = new EventStore(store.pool);
  const mutations = new NetworkRateLimit(120),
    voices = new NetworkRateLimit(2),
    queries = new NetworkRateLimit(30);
  const voicePending = new Set<string>();
  const voiceCancelled = new Set<string>();
  let closing = false;
  const rooms = new Map<
    string,
    { name: string; timer: NodeJS.Timeout; delete: () => Promise<void> }
  >();
  const owner = (r: FastifyRequest, reply: FastifyReply): string => {
    const secure = config.origin
      ? new URL(config.origin).protocol === "https:"
      : r.protocol === "https";
    const name = cookieName("ws_experiences", secure);
    let value = cookie(r, name);
    if (!value || !/^[0-9a-f]{64}$/.test(value)) {
      value = randomBytes(32).toString("hex");
      reply.header(
        "Set-Cookie",
        cookieHeader(name, value, { secure, maxAgeSeconds: 365 * 86400 }),
      );
    }
    return createHash("sha256").update(value).digest("hex");
  };
  const observation = () => {
    const v = host.observation();
    if (!v || !host.worldId)
      throw Object.assign(new Error("forest_unavailable"), { statusCode: 503 });
    return v;
  };
  const moments = async () => {
    const v = observation();
    const p = await events.page({
      actorId: null,
      boundary: { worldTime: v.worldTime, nextSequence: v.nextSequence },
      limit: 24,
      descending: true,
      types: MOMENT_TYPES,
      summary: true,
    });
    return { view: v, moments: p.events.map(forestMoment) };
  };
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (!(error instanceof Error))
        throw new Error("experience_request_failed");
      if (
        [
          "forest_unavailable",
          "checkpoint_unavailable",
          "saving_result_retrying",
        ].includes(error.message)
      )
        return reply.code(503).send({ error: error.message });
      throw error;
    });
    scope.addHook("onRequest", async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Vary", "Cookie");
      if (req.method !== "POST") return;
      if (
        req.headers["sec-fetch-site"] === "cross-site" ||
        (config.origin &&
          req.headers.origin &&
          req.headers.origin !== config.origin)
      )
        return reply.code(403).send({ error: "same_origin_required" });
      if (
        req.headers["x-wildsentia-experience"] !== "1" ||
        !req.headers["content-type"]?.startsWith("application/json")
      )
        return reply.code(415).send({ error: "json_request_required" });
      if (!mutations.take(networkKey(req.ip)).ok)
        return reply.code(429).send({ error: "too_many_requests" });
    });
    scope.get("/experiences/info", async () => ({
      models: config.models,
      liveVoice: !!config.voice,
      missions: ["water", "hunt", "survive"],
      durations: [180, 300],
      scenarios: ["no_rain", "fewer_predators"],
      days: [3, 7, 30],
      voiceSeconds: 180,
    }));
    scope.get("/experiences/moments", async () => {
      const p = await moments();
      return {
        source: "checkpoint",
        worldTime: p.view.worldTime,
        moments: p.moments,
      };
    });
    scope.get<{ Querystring: { q?: string; animal?: string } }>(
      "/experiences/safari",
      async (req, reply) => {
        if (!queries.take(networkKey(req.ip)).ok)
          return reply.code(429).send({ error: "guide_busy" });
        const q = req.query.q ?? "";
        if (
          typeof q !== "string" ||
          q.length > 280 ||
          (req.query.animal && !animalId(req.query.animal))
        )
          return reply.code(400).send({ error: "invalid_question" });
        const p = await moments();
        return safariAnswer(q, req.query.animal ?? null, p.view, p.moments);
      },
    );
    scope.get("/experiences/jobs", async (req, reply) => ({
      jobs: await store.recent(owner(req, reply)),
    }));
    scope.get("/experiences/leaderboard", async () => ({
      matches: await store.leaderboard(),
      ...(await store.season()),
    }));
    scope.get<{ Params: { id: string } }>(
      "/experiences/jobs/:id",
      async (req, reply) => {
        if (!uuid(req.params.id))
          return reply.code(404).send({ error: "not_found" });
        const job = await store.byId(req.params.id, owner(req, reply));
        if (job?.status === "running" && job.progress.standings)
          job.progress.standings = job.progress.standings.map((s) => ({
            ...s,
            frames: [],
          }));
        return job ?? reply.code(404).send({ error: "not_found" });
      },
    );
    scope.post(
      "/experiences/league",
      { bodyLimit: 2048 },
      async (req, reply) => {
        const request = leagueRequest(
          req.body,
          config.models.map((p) => p.id),
        );
        if (!request) return reply.code(400).send({ error: "invalid_match" });
        const job = await service.create(owner(req, reply), request, "league");
        return job
          ? reply.code(202).send(job)
          : reply.code(429).send({ error: "arena_busy_or_hourly_limit" });
      },
    );
    scope.post("/experiences/lab", { bodyLimit: 1024 }, async (req, reply) => {
      const request = labRequest(req.body);
      if (!request)
        return reply.code(400).send({ error: "invalid_experiment" });
      const job = await service.create(owner(req, reply), request, "lab");
      return job
        ? reply.code(202).send(job)
        : reply.code(429).send({ error: "lab_busy_or_hourly_limit" });
    });
    scope.post<{ Params: { id: string } }>(
      "/experiences/jobs/:id/cancel",
      async (req, reply) => {
        if (
          !uuid(req.params.id) ||
          !(await service.cancel(req.params.id, owner(req, reply)))
        )
          return reply.code(404).send({ error: "not_found" });
        return { ok: true };
      },
    );
    scope.post<{ Params: { id: string } }>(
      "/experiences/jobs/:id/command",
      { bodyLimit: 1024 },
      async (req, reply) => {
        const command = arenaCommand(req.body);
        if (!command) return reply.code(400).send({ error: "invalid_command" });
        if (
          !uuid(req.params.id) ||
          !service.command(req.params.id, owner(req, reply), command)
        )
          return reply.code(404).send({ error: "not_playing" });
        return { ok: true };
      },
    );
    scope.get("/experiences/follows", async (req, reply) => {
      const view = observation(),
        rows = await store.follows(owner(req, reply), host.worldId!);
      const lives: FollowedLife[] = [];
      for (const row of rows) {
        const a = view.animal(row.animal_id);
        const p = await events.page({
          actorId: row.animal_id,
          boundary: {
            worldTime: view.worldTime,
            nextSequence: view.nextSequence,
          },
          limit: 8,
          descending: true,
          types: MOMENT_TYPES,
          summary: true,
        });
        lives.push({
          animalId: row.animal_id,
          nickname: row.nickname,
          alive: a?.alive ?? null,
          speciesId: a?.speciesId ?? null,
          motherId: a?.motherId ?? null,
          fatherId: a?.fatherId ?? null,
          offspringIds: a?.offspringIds ?? [],
          moments: p.events.map(forestMoment),
          unread: p.events.filter(
            (e) => (eventSequence(e.id) ?? -1) >= Number(row.seen_sequence),
          ).length,
        });
      }
      return {
        lives,
        worldTime: view.worldTime,
        seenThrough: view.nextSequence,
      };
    });
    scope.post(
      "/experiences/follows",
      { bodyLimit: 1024 },
      async (req, reply) => {
        const b = body(req),
          view = observation();
        if (
          !animalId(b.animalId) ||
          !view.animal(b.animalId) ||
          typeof b.nickname !== "string" ||
          b.nickname.length > 64
        )
          return reply.code(400).send({ error: "invalid_animal_or_nickname" });
        if (
          !(await store.follow(
            owner(req, reply),
            host.worldId!,
            b.animalId,
            b.nickname.trim(),
            view.nextSequence,
          ))
        )
          return reply.code(409).send({ error: "follow_limit" });
        return { ok: true };
      },
    );
    scope.post("/experiences/follows/remove", async (req, reply) => {
      const id = body(req).animalId;
      if (!animalId(id))
        return reply.code(400).send({ error: "invalid_animal" });
      await store.unfollow(owner(req, reply), host.worldId!, id);
      return { ok: true };
    });
    scope.post("/experiences/follows/seen", async (req, reply) => {
      const n = body(req).sequence,
        v = observation();
      if (
        !Number.isSafeInteger(n) ||
        Number(n) < 0 ||
        Number(n) > v.nextSequence
      )
        return reply.code(400).send({ error: "invalid_boundary" });
      await store.seen(owner(req, reply), host.worldId!, Number(n));
      return { ok: true };
    });
    scope.post("/experiences/voice", async (req, reply) => {
      if (!config.voice || closing)
        return reply.code(503).send({ error: "live_voice_unavailable" });
      const key = owner(req, reply);
      if (
        rooms.has(key) ||
        voicePending.has(key) ||
        rooms.size + voicePending.size >= 5 ||
        !voices.take(networkKey(req.ip)).ok
      )
        return reply.code(429).send({ error: "voice_limit" });
      voicePending.add(key);
      voiceCancelled.delete(key);
      try {
        if (
          !(await store.reserve(
            "voice_seconds",
            180,
            config.voice.dailySeconds,
          ))
        )
          return reply.code(429).send({ error: "voice_limit" });
        const v = config.voice,
          name = `safari-${randomBytes(12).toString("hex")}`;
        const client = new RoomServiceClient(
          v.url.replace(/^wss:/, "https:"),
          v.key,
          v.secret,
        );
        await client.createRoom({ name, emptyTimeout: 30, maxParticipants: 2 });
        try {
          await new AgentDispatchClient(
            v.url.replace(/^wss:/, "https:"),
            v.key,
            v.secret,
          ).createDispatch(name, v.agent);
        } catch {
          await client.deleteRoom(name).catch(() => undefined);
          return reply.code(503).send({ error: "voice_agent_unavailable" });
        }
        if (closing || voiceCancelled.has(key)) {
          await client.deleteRoom(name).catch(() => undefined);
          return reply.code(409).send({ error: "voice_stopped" });
        }
        const remove = async () => {
          rooms.delete(key);
          await client.deleteRoom(name).catch(() => undefined);
        };
        const timer = setTimeout(() => {
          void remove();
        }, 185_000);
        timer.unref();
        rooms.set(key, { name, timer, delete: remove });
        const token = new AccessToken(v.key, v.secret, {
          identity: `visitor-${key.slice(0, 16)}`,
          ttl: 180,
        });
        token.addGrant({
          roomJoin: true,
          room: name,
          canPublish: true,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: true,
          canPublishData: false,
        });
        return {
          url: v.url,
          token: await token.toJwt(),
          expiresInSeconds: 180,
        };
      } finally {
        voicePending.delete(key);
        voiceCancelled.delete(key);
      }
    });
    scope.post("/experiences/voice/stop", async (req, reply) => {
      const key = owner(req, reply),
        room = rooms.get(key);
      if (voicePending.has(key)) voiceCancelled.add(key);
      if (room) {
        clearTimeout(room.timer);
        await room.delete();
      }
      return { ok: true };
    });
  });
  app.addHook("onClose", async () => {
    closing = true;
    for (const room of rooms.values()) {
      clearTimeout(room.timer);
      await room.delete();
    }
    await service.stop();
  });
}
