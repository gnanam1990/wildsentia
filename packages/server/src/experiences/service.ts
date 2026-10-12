import { Worker } from "node:worker_threads";
import type {
  ExperienceJob,
  LeagueRequest,
  LabRequest,
  LeagueStanding,
  ArenaCommand,
  ArenaFrame,
  LeaguePlayer,
  LabResult,
} from "@vana/shared";
import { SnapshotStore } from "../db/snapshotStore.js";
import type { SimHost } from "../simHost.js";
import type { ExperienceStore } from "./store.js";
import type { ExperienceConfig } from "./config.js";
import { LeagueProvider } from "./provider.js";
import type { WorkerInput } from "./worker.js";
type Active = {
  job: ExperienceJob;
  owner: string;
  workers: Map<string, Worker>;
  standings: Map<string, LeagueStanding>;
  ended: Set<string>;
  writes: Promise<void>;
  timer: NodeJS.Timeout;
  closed: boolean;
  abort: AbortController;
  terminal?: {
    status: Exclude<ExperienceJob["status"], "running">;
    result: ExperienceJob["result"];
    error: string | null;
  };
  committing?: Promise<void>;
  retryTimer?: NodeJS.Timeout;
};
export class ExperienceService {
  readonly active = new Map<string, Active>();
  readonly provider: LeagueProvider;
  #stopped = false;
  constructor(
    readonly store: ExperienceStore,
    readonly host: SimHost,
    readonly config: ExperienceConfig,
    readonly speciesDir: string,
  ) {
    this.provider = new LeagueProvider(config, store);
  }
  async start(): Promise<void> {
    await this.store.recover();
  }
  async create(
    owner: string,
    request: LeagueRequest | LabRequest,
    kind: "league" | "lab",
  ): Promise<ExperienceJob | null> {
    if (this.#stopped || !this.host.observation())
      throw new Error("forest_unavailable");
    let snapshot = null;
    if (kind === "lab") {
      snapshot = await new SnapshotStore(this.store.pool).loadLatest();
      if (!snapshot) throw new Error("checkpoint_unavailable");
    }
    const job = await this.store.create(owner, kind, request);
    if (!job) return null;
    const a: Active = {
      job,
      owner,
      workers: new Map(),
      standings: new Map(),
      ended: new Set(),
      writes: Promise.resolve(),
      closed: false,
      abort: new AbortController(),
      timer: setTimeout(
        () => {
          void this.finish(job.id, "failed", null, "time_limit");
        },
        kind === "lab"
          ? 10 * 60_000
          : ((request as LeagueRequest).durationSeconds + 25) * 1000,
      ),
    };
    a.timer.unref();
    this.active.set(job.id, a);
    try {
      if (kind === "lab")
        this.spawn(a, "lab", {
          kind,
          request: request as LabRequest,
          snapshot: snapshot!,
          speciesDir: this.speciesDir,
        });
      else
        for (const id of (request as LeagueRequest).players) {
          const player = this.config.models.find((p) => p.id === id)!;
          this.spawn(a, id, {
            kind,
            request: request as LeagueRequest,
            player,
            speciesDir: this.speciesDir,
          });
        }
    } catch {
      await this.finish(job.id, "failed", null, "worker_unavailable");
    }
    return (await this.store.byId(job.id, owner))!;
  }
  private spawn(a: Active, id: string, input: WorkerInput): void {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = new Worker(
      new URL(`./worker.${extension}`, import.meta.url),
      {
        workerData: input,
        env: {},
        ...(extension === "ts" ? { execArgv: ["--import", "tsx"] } : {}),
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      },
    );
    a.workers.set(id, worker);
    worker.on(
      "message",
      (m: {
        type: string;
        frame: ArenaFrame;
        decisions: number;
        providerError: boolean;
        observation: unknown;
        percent: number;
        baseline: NonNullable<ExperienceJob["progress"]["baseline"]>;
        experiment: NonNullable<ExperienceJob["progress"]["experiment"]>;
        result: LabResult;
        turn: number;
      }) => {
        if (a.closed) return;
        if (m.type === "failed") {
          void this.finish(a.job.id, "failed", null, "simulation_failed");
          return;
        }
        if (m.type === "model_request") {
          if (
            input.kind !== "league" ||
            input.player.source !== "openrouter" ||
            m.decisions > 8
          )
            return;
          void this.provider
            .decide(
              input.player.id,
              input.request.mission,
              m.observation,
              a.abort.signal,
            )
            .then((command) => {
              if (!a.closed && !a.ended.has(id))
                worker.postMessage({
                  type: "model_command",
                  command,
                  turn: m.turn,
                });
            })
            .catch(() => {
              if (!a.closed && !a.ended.has(id))
                worker.postMessage({
                  type: "model_command",
                  error: "provider_unavailable",
                });
            });
          return;
        }
        if (m.type === "lab_progress")
          this.progress(a, {
            percent: m.percent,
            baseline: m.baseline,
            experiment: m.experiment,
          });
        if (m.type === "lab_done") {
          a.ended.add(id);
          void this.finish(a.job.id, "completed", m.result);
        }
        if (
          (m.type === "league_frame" || m.type === "league_done") &&
          input.kind === "league"
        ) {
          const previous = a.standings.get(id);
          const frames = previous?.frames ?? [];
          if (!frames.length || frames.at(-1)!.second !== m.frame.second)
            frames.push(m.frame);
          else frames[frames.length - 1] = m.frame;
          if (frames.length > 301) frames.shift();
          a.standings.set(id, {
            player: input.player,
            frame: m.frame,
            frames,
            status: m.providerError
              ? "provider_error"
              : m.type === "league_done"
                ? "finished"
                : "playing",
            decisions: m.decisions,
          });
          this.progress(a, {
            percent: Math.min(
              ...[...a.standings.values()].map((s) =>
                s.status === "playing"
                  ? (s.frame.second / input.request.durationSeconds) * 100
                  : 100,
              ),
            ),
            standings: this.standings(a),
          });
          if (m.type === "league_done") {
            a.ended.add(id);
            if (a.ended.size === input.request.players.length) {
              const standings = this.standings(a),
                eligible = standings.filter(
                  (s) =>
                    s.status !== "provider_error" &&
                    s.frame.completedAt !== null,
                );
              const best = eligible.length
                ? Math.max(...eligible.map((s) => s.frame.points))
                : null;
              void this.finish(a.job.id, "completed", {
                standings,
                winners: eligible
                  .filter((s) => s.frame.points === best)
                  .map((s) => s.player.id),
              });
            }
          }
        }
      },
    );
    worker.once("error", () => {
      if (!a.closed)
        void this.finish(a.job.id, "failed", null, "worker_failed");
    });
    worker.once("exit", (code) => {
      if (!a.closed && (!a.ended.has(id) || code !== 0))
        void this.finish(a.job.id, "failed", null, "worker_stopped");
    });
  }
  private standings(a: Active): LeagueStanding[] {
    return (a.job.request as LeagueRequest).players.flatMap((id) => {
      const s = a.standings.get(id);
      return s ? [structuredClone(s)] : [];
    });
  }
  private progress(a: Active, progress: ExperienceJob["progress"]): void {
    a.job.progress = structuredClone(progress);
    // Serialize writes: a late progress acknowledgement must not overwrite a terminal result.
    if (
      a.job.kind === "league" &&
      ![...a.standings.values()].some(
        (s) => s.frame.second % 3 === 0 || s.status !== "playing",
      )
    )
      return;
    const p = structuredClone(progress);
    a.writes = a.writes
      .then(() => this.store.progress(a.job.id, p))
      .catch(() => {
        void this.finish(a.job.id, "failed", null, "persistence_unavailable");
      });
  }
  async finish(
    id: string,
    status: Exclude<ExperienceJob["status"], "running">,
    result: ExperienceJob["result"],
    error: string | null = null,
  ): Promise<void> {
    const a = this.active.get(id);
    if (!a) return;
    if (a.closed) {
      await a.committing;
      return;
    }
    a.closed = true;
    a.terminal = { status, result: structuredClone(result), error };
    a.abort.abort();
    clearTimeout(a.timer);
    a.committing = (async () => {
      await Promise.allSettled(
        [...a.workers.values()].map((w) => w.terminate()),
      );
      await a.writes;
      await this.commitTerminal(a);
    })();
    await a.committing;
  }
  private async commitTerminal(a: Active): Promise<void> {
    if (!a.terminal) return;
    const t = a.terminal;
    try {
      await this.store.finish(a.job.id, t.status, t.result, t.error);
      this.active.delete(a.job.id);
    } catch {
      console.error(
        "[experiences] saving terminal result failed; retrying while the server is running",
      );
      if (!this.#stopped) {
        a.retryTimer = setTimeout(() => {
          a.committing = this.commitTerminal(a);
        }, 5000);
        a.retryTimer.unref();
      }
    }
  }
  command(id: string, owner: string, command: ArenaCommand): boolean {
    const a = this.active.get(id);
    if (!a || a.closed || a.owner !== owner || a.ended.has("human"))
      return false;
    const human = a.workers.get("human");
    if (!human) return false;
    human.postMessage({ type: "human_command", command });
    return true;
  }
  async cancel(id: string, owner: string): Promise<boolean> {
    const a = this.active.get(id);
    if (!a || a.owner !== owner || a.closed) return false;
    await this.finish(id, "cancelled", null);
    if (this.active.has(id))
      throw Object.assign(new Error("saving_result_retrying"), {
        statusCode: 503,
      });
    return true;
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.provider.stop();
    await Promise.all(
      [...this.active.keys()].map((id) =>
        this.finish(id, "interrupted", null, "server_stopped"),
      ),
    );
    for (const a of this.active.values()) {
      clearTimeout(a.retryTimer);
      await this.commitTerminal(a);
    }
  }
}
