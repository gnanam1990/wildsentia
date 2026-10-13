import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fileURLToPath } from "node:url";
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
} from "livekit-server-sdk";
import {
  arenaCommand,
  labRequest,
  leagueRequest,
  type ArenaFrame,
} from "@vana/shared";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { ExperienceStore } from "../src/experiences/store.js";
import { ExperienceService } from "../src/experiences/service.js";
import { experienceConfig } from "../src/experiences/config.js";
import { LeagueProvider } from "../src/experiences/provider.js";
import { SimHost } from "./trackedHost.js";
import { buildApi } from "../src/api.js";
import { testDatabaseUrl } from "./testDatabase.js";

const speciesDir = fileURLToPath(
  new URL("../../../config/species", import.meta.url),
);
const match = {
  mission: "water" as const,
  species: "tiger" as const,
  durationSeconds: 180 as const,
  seed: 42,
  players: ["local:forager", "local:careful"],
};
const headers = {
  "content-type": "application/json",
  "x-wildsentia-experience": "1",
};
const ownerA = "a".repeat(64),
  ownerB = "b".repeat(64);
const url = testDatabaseUrl(),
  pool = url ? createPool(url) : null;
const database = url ? describe : describe.skip;

afterAll(async () => {
  await pool?.end();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("experience contracts and optional providers", () => {
  it("parses only allowed distinct model entries, finite seeds and bounded durations", () => {
    expect(leagueRequest(match, match.players)).toEqual(match);
    for (const change of [
      { players: ["human", "human"] },
      { players: ["https://evil", "local:forager"] },
      { seed: NaN },
      { seed: -1 },
      { seed: 1.5 },
      { durationSeconds: "180" },
      { durationSeconds: 181 },
      { mission: ["water"] },
      { species: ["tiger"] },
      { mission: "hunt", species: "hare" },
    ])
      expect(
        leagueRequest({ ...match, ...change }, [...match.players, "human"]),
      ).toBeNull();
  });
  it("rejects coercible command objects, non-finite positions and extra capability types", () => {
    for (const c of [
      { action: ["rest"] },
      { action: "go_to", x: Infinity, z: 0, gait: "walk" },
      { action: "go_to", x: 0, z: 0, gait: ["walk"] },
      { action: "shell" },
      { action: "hunt", preyId: "../private" },
    ])
      expect(arenaCommand(c)).toBeNull();
    expect(arenaCommand({ action: "rest", tool: "ignored" })).toEqual({
      action: "rest",
    });
    expect(labRequest({ scenario: ["no_rain"], days: 3 })).toBeNull();
    expect(labRequest({ scenario: "no_rain", days: "3" })).toBeNull();
    expect(labRequest({ scenario: "no_rain", days: 3 })).toEqual({
      scenario: "no_rain",
      days: 3,
    });
  });
  it("keeps paid providers absent by default and validates deployment settings", () => {
    expect(
      experienceConfig({
        OPENROUTER_API_KEY: "synthetic-test-key",
        VANA_LEAGUE_MODELS: "vendor/model",
      }).models,
    ).toHaveLength(3);
    expect(experienceConfig({}).voice).toBeNull();
    for (const env of [
      { VANA_EXPERIENCES_ORIGIN: "http://public.example" },
      { VANA_EXPERIENCES_ORIGIN: "https://host/path" },
      { VANA_LEAGUE_MODELS: "../model" },
      { VANA_LEAGUE_DAILY_TOKENS: "-1" },
      { VANA_SAFARI_LIVEKIT: "1" },
    ])
      expect(() => experienceConfig(env)).toThrow();
  });
  const config = () =>
    experienceConfig({
      OPENROUTER_API_KEY: "synthetic-test-key",
      VANA_LEAGUE_PUBLIC_MODELS: "1",
      VANA_LEAGUE_MODELS: "vendor/model",
    });
  it("reserves a bounded budget before a fixed-endpoint provider call and strips unrelated output fields", async () => {
    const reserve = vi.fn().mockResolvedValue(true),
      http = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '{"action":"rest","shell":"never used"}',
                  },
                },
              ],
            }),
          ),
        );
    const provider = new LeagueProvider(
      config(),
      { reserve } as unknown as ExperienceStore,
      http,
    );
    expect(
      await provider.decide("openrouter:vendor/model", "water", {
        animal: "tiger",
      }),
    ).toEqual({ action: "rest" });
    expect(reserve).toHaveBeenCalledWith("model_tokens", 9000, 200000);
    expect(http.mock.calls[0]![0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(JSON.parse(http.mock.calls[0]![1].body)).toMatchObject({
      model: "vendor/model",
      max_tokens: 256,
      reasoning: { enabled: false },
    });
    expect(provider.pending.size).toBe(0);
  });
  it("does not call a provider without quota, a registered model, or a small observation", async () => {
    const reserve = vi.fn().mockResolvedValue(false),
      http = vi.fn(),
      provider = new LeagueProvider(
        config(),
        { reserve } as unknown as ExperienceStore,
        http,
      );
    await expect(
      provider.decide("openrouter:vendor/model", "water", {}),
    ).rejects.toThrow("budget");
    await expect(
      provider.decide("openrouter:other/model", "water", {}),
    ).rejects.toThrow("unavailable");
    await expect(
      provider.decide("openrouter:vendor/model", "water", {
        x: "a".repeat(6000),
      }),
    ).rejects.toThrow("large");
    expect(http).not.toHaveBeenCalled();
  });
  it.each([
    "not-json",
    JSON.stringify({
      choices: [{ message: { content: '{"action":"wallet"}' } }],
    }),
    "a".repeat(64001),
  ])(
    "rejects invalid or oversized responses without a fallback winner",
    async (response) => {
      const provider = new LeagueProvider(
        config(),
        { reserve: async () => true } as unknown as ExperienceStore,
        vi.fn().mockResolvedValue(new Response(response)),
      );
      await expect(
        provider.decide("openrouter:vendor/model", "hunt", {}),
      ).rejects.toThrow();
      expect(provider.pending.size).toBe(0);
    },
  );
  it("aborts an in-flight provider request when the match is cancelled", async () => {
    const provider = new LeagueProvider(
      config(),
      { reserve: async () => true } as unknown as ExperienceStore,
      ((_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        })) as typeof fetch,
    );
    const cancelled = new AbortController();
    const promise = provider.decide(
      "openrouter:vendor/model",
      "survive",
      {},
      cancelled.signal,
    );
    await vi.waitFor(() => expect(provider.pending.size).toBe(1));
    cancelled.abort();
    await expect(promise).rejects.toThrow("cancelled");
    expect(provider.pending.size).toBe(0);
  });
});

database("durable experience API and jobs", () => {
  let store: ExperienceStore,
    host: SimHost,
    service: ExperienceService,
    api: ReturnType<typeof buildApi>;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query(
      "truncate experience_jobs, experience_scores, experience_follows, experience_budgets, events, snapshots, human_motion, follows, viewers, tracks, animal_archive cascade",
    );
    store = new ExperienceStore(pool!);
    host = new SimHost({
      pool: pool!,
      seed: 42,
      speciesDir,
      initialAgents: { tiger: 4, chital: 8 },
      minPopulation: {},
      terrainProfile: "island_v2",
    });
    await host.boot();
    service = new ExperienceService(
      store,
      host,
      experienceConfig({}),
      speciesDir,
    );
    await service.start();
    api = buildApi({
      host,
      pool: pool!,
      experiences: service,
      limits: { publicReadsPerMinute: 0 },
    });
    await api.ready();
  });
  afterEach(async () => {
    await api?.close();
    await host?.abort();
  });
  it("serializes concurrent starts across owners and never exposes another profile record", async () => {
    const jobs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.create(i % 2 ? ownerA : ownerB, "league", match),
      ),
    );
    expect(jobs.filter(Boolean)).toHaveLength(2);
    const j = jobs.find(Boolean)!;
    const a = await store.byId(j.id, ownerA),
      b = await store.byId(j.id, ownerB);
    expect(Number(!!a) + Number(!!b)).toBe(1);
    expect((await api.inject(`/experiences/jobs/${j.id}`)).statusCode).toBe(
      404,
    );
  });
  it("enforces the per-profile hourly limit after completed/cancelled starts", async () => {
    for (let i = 0; i < 4; i++) {
      const j = (await store.create(ownerA, "league", match))!;
      expect(j).not.toBeNull();
      await store.finish(j.id, "cancelled", null);
    }
    expect(await store.create(ownerA, "league", match)).toBeNull();
    expect(await store.create(ownerB, "league", match)).not.toBeNull();
  });
  it("atomically caps concurrent paid reservations, including first inserts", async () => {
    const reservations = await Promise.all(
      Array.from({ length: 12 }, () => store.reserve("test_tokens", 9, 18)),
    );
    expect(reservations.filter(Boolean)).toHaveLength(2);
    expect(await store.reserve("test_tokens", 1, 18)).toBe(false);
    expect(await store.reserve("invalid", 0, 100)).toBe(false);
  });
  it("requires same-origin JSON for all mutations and returns a private HttpOnly browser profile", async () => {
    for (const h of [
      {},
      {
        ...headers,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      { "content-type": "application/json" },
    ])
      expect(
        (
          await api.inject({
            method: "POST",
            url: "/experiences/league",
            headers: h,
            payload: match,
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(400);
    const res = await api.inject("/experiences/jobs");
    expect(res.headers["set-cookie"]).toContain("HttpOnly");
    expect(res.headers["cache-control"]).toBe("no-store");
    const invalid = await api.inject({
      method: "POST",
      url: "/experiences/league",
      headers,
      payload: { ...match, players: ["human", "human"] },
    });
    expect(invalid.statusCode).toBe(400);
  });
  it("scopes follows to both profile and world and keeps seen boundaries monotonic", async () => {
    const id = host.world.agents[0]!.id,
      world = host.worldId!;
    expect(
      await store.follow(
        ownerA,
        world,
        id,
        "<script>literal nickname</script>",
        5,
      ),
    ).toBe(true);
    expect(await store.follows(ownerB, world)).toEqual([]);
    expect(await store.follows(ownerA, "other-world")).toEqual([]);
    await store.seen(ownerA, world, 20);
    await store.seen(ownerA, world, 2);
    await store.follow(ownerA, world, id, "new name", 1);
    expect(await store.follows(ownerA, world)).toEqual([
      expect.objectContaining({ nickname: "new name", seen_sequence: "20" }),
    ]);
    await store.unfollow(ownerB, world, id);
    expect(await store.follows(ownerA, world)).toHaveLength(1);
  });
  it("enforces twenty follows under concurrent requests", async () => {
    const r = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.follow(ownerA, "test-world", `animal-${i}`, "", 0),
      ),
    );
    expect(r.filter(Boolean)).toHaveLength(20);
    expect(
      await store.follow(ownerA, "test-world", "animal-0", "renamed", 0),
    ).toBe(true);
  });
  it("keeps a monthly score once even if terminal persistence is retried and late progress arrives", async () => {
    const job = (await store.create(ownerA, "league", match))!;
    const frame = { points: 120 } as ArenaFrame;
    const result = {
      standings: [
        {
          player: {
            id: "local:forager",
            label: "Forager",
            source: "local" as const,
          },
          frame,
          frames: [],
          status: "finished" as const,
          decisions: 2,
        },
      ],
      winners: ["local:forager"],
    };
    await Promise.all([
      store.finish(job.id, "completed", result),
      store.finish(job.id, "completed", result),
    ]);
    await store.progress(job.id, { percent: 1 });
    expect((await store.byId(job.id, ownerA))?.status).toBe("completed");
    expect((await store.season()).rows).toEqual([
      expect.objectContaining({ matches: 1, wins: 1, points: "120" }),
    ]);
    await pool!.query(
      "update experience_jobs set created_at=now()-interval '31 days' where id=$1",
      [job.id],
    );
    await store.recover();
    expect(await store.byId(job.id, ownerA)).toBeNull();
    expect((await store.season()).rows[0]!.wins).toBe(1);
  });
  it("marks stale running jobs interrupted after server recovery", async () => {
    const job = (await store.create(ownerA, "league", match))!;
    await store.recover();
    expect(await store.byId(job.id, ownerA)).toMatchObject({
      status: "interrupted",
      error: "server_restarted",
    });
  });
  it("grounds Safari in the saved checkpoint even while the live world changes", async () => {
    const id = host.world.agents.find((a) => a.speciesId === "tiger")!.id;
    const saved = (
      await api.inject(`/experiences/safari?q=tiger&animal=${id}`)
    ).json();
    host.world.animal(id)!.drives.thirst = 0.99;
    expect(
      (await api.inject(`/experiences/safari?q=tiger&animal=${id}`)).json(),
    ).toEqual(saved);
    expect(saved).toMatchObject({ source: "checkpoint", animalId: id });
  });
  it("starts real worker arenas, streams frames, and cancels only the owning profile", async () => {
    const res = await api.inject({
      method: "POST",
      url: "/experiences/league",
      headers,
      payload: { ...match, players: ["human", "local:careful"] },
    });
    expect(res.statusCode).toBe(202);
    const job = res.json(),
      cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    await vi.waitFor(
      async () => {
        const saved = (
          await api.inject({
            url: `/experiences/jobs/${job.id}`,
            headers: { cookie },
          })
        ).json();
        expect(saved.progress.standings).toHaveLength(2);
        expect(saved.progress.standings[0].frames).toEqual([]);
      },
      { timeout: 15000 },
    );
    expect(
      (
        await api.inject({
          method: "POST",
          url: `/experiences/jobs/${job.id}/cancel`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api.inject({
          method: "POST",
          url: `/experiences/jobs/${job.id}/command`,
          headers: { ...headers, cookie },
          payload: { action: "rest" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api.inject({
          method: "POST",
          url: `/experiences/jobs/${job.id}/cancel`,
          headers: { ...headers, cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(service.active.size).toBe(0);
    expect(
      (
        await api.inject({
          url: `/experiences/jobs/${job.id}`,
          headers: { cookie },
        })
      ).json().status,
    ).toBe("cancelled");
  });
  it("retries terminal persistence without leaving finished workers or double scores", async () => {
    vi.useFakeTimers();
    const job = (await store.create(ownerA, "league", match))!;
    const finish = vi
      .spyOn(store, "finish")
      .mockRejectedValueOnce(new Error("temporary database failure"));
    service.active.set(job.id, {
      job,
      owner: ownerA,
      workers: new Map(),
      standings: new Map(),
      ended: new Set(),
      writes: Promise.resolve(),
      timer: setTimeout(() => undefined, 60000),
      closed: false,
      abort: new AbortController(),
    });
    await service.finish(job.id, "completed", { standings: [], winners: [] });
    expect(service.active.get(job.id)?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await service.active.get(job.id)?.committing;
    expect(finish).toHaveBeenCalledTimes(2);
    expect(service.active.size).toBe(0);
    expect((await store.byId(job.id, ownerA))?.status).toBe("completed");
  });
  it("makes no cloud call for disabled voice; provisioned tokens are mic-only and stop deletes the room", async () => {
    expect(
      (
        await api.inject({
          method: "POST",
          url: "/experiences/voice",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(503);
    await api.close();
    const config = experienceConfig({
      VANA_SAFARI_LIVEKIT: "1",
      LIVEKIT_URL: "wss://synthetic.example",
      LIVEKIT_API_KEY: "synthetic-key",
      LIVEKIT_API_SECRET: "synthetic-secret",
    });
    service = new ExperienceService(store, host, config, speciesDir);
    vi.spyOn(RoomServiceClient.prototype, "createRoom").mockResolvedValue(
      {} as never,
    );
    const dispatch = vi
      .spyOn(AgentDispatchClient.prototype, "createDispatch")
      .mockResolvedValue({} as never);
    const remove = vi
      .spyOn(RoomServiceClient.prototype, "deleteRoom")
      .mockResolvedValue();
    api = buildApi({ host, pool: pool!, experiences: service });
    await api.ready();
    const res = await api.inject({
      method: "POST",
      url: "/experiences/voice",
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const claims = JSON.parse(
      Buffer.from(res.json().token.split(".")[1], "base64url").toString(),
    );
    expect(claims.video).toMatchObject({
      canPublishSources: ["microphone"],
      canPublishData: false,
    });
    expect(claims.exp - claims.nbf).toBe(180);
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    expect(
      (
        await api.inject({
          method: "POST",
          url: "/experiences/voice",
          headers: { ...headers, cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(429);
    await api.inject({
      method: "POST",
      url: "/experiences/voice/stop",
      headers: { ...headers, cookie },
      payload: {},
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
