import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import {
  createWorld,
  takeSnapshot,
  restoreSnapshot,
  totalNutrients,
} from "@vana/sim";
import { type ArenaFrame, type LabResult } from "@vana/shared";
import { experimentSnapshot } from "../src/experiences/worker.js";
import type { WorkerInput } from "../src/experiences/worker.js";

const speciesDir = fileURLToPath(
  new URL("../../../config/species", import.meta.url),
);
const options = {
  seed: 42,
  speciesDir,
  initialAgents: { tiger: 4, leopard: 4, dhole: 4, chital: 12 },
  minPopulation: {},
  terrainProfile: "island_v2" as const,
};
function run(
  input: WorkerInput,
  check?: (message: any, worker: Worker) => void,
  timeout = 60000,
): Promise<any> {
  const worker = new Worker(
    new URL("../src/experiences/worker.ts", import.meta.url),
    { workerData: input, env: {}, execArgv: ["--import", "tsx"] },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("worker test timed out")),
      timeout,
    );
    worker.once("exit", () => clearTimeout(timer));
    worker.on("error", reject);
    worker.on("message", (m) => {
      try {
        check?.(m, worker);
        if (m.type === "failed") reject(new Error("simulation failed"));
        if (m.type === "lab_done" || m.type === "league_done") resolve(m);
      } catch (error) {
        reject(error);
      }
    });
    worker.on("exit", (code) => {
      if (code) reject(new Error(`worker exited ${code}`));
    });
  }).finally(async () => {
    await worker.terminate();
  });
}

describe("actual experience simulation workers", () => {
  it("counts the Congo forest's leopards and golden cats as predators in the fewer-predators lab", () => {
    const source = takeSnapshot(createWorld(options));
    for (const a of source.agents) {
      if (a.speciesId === "tiger") a.speciesId = "african_leopard";
      else if (a.speciesId === "leopard") a.speciesId = "african_golden_cat";
    }
    const counts = (s: typeof source) => ["african_leopard", "african_golden_cat"]
      .map((id) => s.agents.filter((a) => a.speciesId === id).length);
    const [leopards, cats] = counts(source);
    const changed = experimentSnapshot(source, "fewer_predators");
    expect(counts(changed.snapshot)).toEqual([Math.ceil(leopards! / 2), Math.ceil(cats! / 2)]);
    expect(changed.removed).toBeGreaterThanOrEqual(Math.floor(leopards! / 2) + Math.floor(cats! / 2));
  });
  it("removes exactly half each predator species without mutating the source or losing nutrient accounting", () => {
    const w = createWorld(options),
      source = takeSnapshot(w),
      original = JSON.stringify(source);
    const changed = experimentSnapshot(source, "fewer_predators");
    expect(changed.removed).toBe(6);
    expect(JSON.stringify(source)).toBe(original);
    const restored = restoreSnapshot(changed.snapshot, options);
    expect(restored.agents.filter((a) => a.speciesId === "tiger")).toHaveLength(
      2,
    );
    expect(
      restored.deceased.filter((a) => a.state === "emigrated"),
    ).toHaveLength(6);
    const nutrients = (world: typeof w) =>
      totalNutrients(
        world.patches,
        world.agents,
        world.ledger,
        world.carcasses,
        world.microEcology,
        world.community,
      );
    expect(nutrients(restored)).toBeCloseTo(nutrients(w), 5);
  });
  it("preserves default rainfall behavior and rejects invalid experimental scaling", () => {
    const a = createWorld(options),
      b = createWorld({ ...options, rainfallScale: 1 });
    for (let i = 0; i < 3; i++) {
      a.step(1);
      b.step(1);
    }
    expect(takeSnapshot(b)).toEqual(takeSnapshot(a));
    for (const rainfallScale of [NaN, Infinity, -1, 1.01])
      expect(() => createWorld({ ...options, rainfallScale })).toThrow(
        "rainfall",
      );
  });
  it.each(["no_rain", "fewer_predators"] as const)(
    "runs a real three-day %s checkpoint comparison in separate forks",
    async (scenario) => {
      const source = takeSnapshot(createWorld(options)),
        original = JSON.stringify(source),
        progress: number[] = [];
      const message = await run(
        {
          kind: "lab",
          request: { scenario, days: 3 },
          snapshot: source,
          speciesDir,
        },
        (m) => {
          if (m.type === "lab_progress") progress.push(m.percent);
        },
        120000,
      );
      const result: LabResult = message.result;
      expect(result.completedDays).toBe(3);
      expect(progress).toHaveLength(6);
      expect(progress.at(-1)).toBe(100);
      expect(result.baseline.map((s) => s.day)).toEqual([0, 1, 2, 3]);
      expect(result.experiment).toHaveLength(4);
      expect(JSON.stringify(source)).toBe(original);
      expect(result.checkpointWorldTime).toBe(source.worldTime);
      expect(result.baseline[0]!.nutrients).toBeCloseTo(
        result.experiment[0]!.nutrients,
        5,
      );
      for (const s of [...result.baseline, ...result.experiment])
        for (const n of [
          s.waterL,
          s.vegetationKg,
          s.nutrients,
          s.births,
          s.deaths,
        ])
          expect(Number.isFinite(n)).toBe(true);
      if (scenario === "fewer_predators") expect(result.removedAnimals).toBe(6);
    },
    150000,
  );
  it("completes an actual local water mission and saves bounded command turns and real positions", async () => {
    const frames: ArenaFrame[] = [];
    const result = await run(
      {
        kind: "league",
        request: {
          mission: "water",
          species: "tiger",
          durationSeconds: 180,
          seed: 42,
          players: ["local:forager", "local:careful"],
        },
        player: { id: "local:forager", label: "Forager", source: "local" },
        speciesDir,
      },
      (m) => {
        if (m.type === "league_frame") frames.push(m.frame);
      },
      120000,
    );
    expect(result.providerError).toBe(false);
    expect(result.frame.drank).toBe(true);
    expect(result.frame.completedAt).not.toBeNull();
    expect(result.decisions).toBeLessThanOrEqual(8);
    expect(frames[0]!.animal).not.toBeNull();
    expect(frames[0]!.water.length).toBeGreaterThan(0);
    expect(result.frame.points).toBeGreaterThanOrEqual(100);
  }, 150000);
  it("plays a match in the Congo forest with its own animals when the world is the Congo", async () => {
    const frames: ArenaFrame[] = [];
    const result = await run(
      {
        kind: "league",
        request: {
          mission: "water",
          species: "blue_duiker",
          durationSeconds: 180,
          seed: 42,
          players: ["local:forager", "local:careful"],
        },
        player: { id: "local:forager", label: "Forager", source: "local" },
        speciesDir: fileURLToPath(new URL("../../../config/species-congo", import.meta.url)),
        world: "congo",
      },
      (m) => {
        if (m.type === "league_frame") frames.push(m.frame);
      },
      120000,
    );
    expect(result.providerError).toBe(false);
    expect(frames[0]!.animal?.speciesId).toBe("blue_duiker");
    const seen = new Set(frames.flatMap((f) => f.nearby.map((a) => a.speciesId)));
    expect([...seen].every((id) => !["tiger", "chital", "hare", "leopard"].includes(id))).toBe(true);
    expect(seen.size).toBeGreaterThan(0);
    expect(result.frame.drank).toBe(true);
  }, 150000);
  it("disqualifies a failed model, and cannot silently substitute a local strategy", async () => {
    let requests = 0;
    const result = await run(
      {
        kind: "league",
        request: {
          mission: "survive",
          species: "tiger",
          durationSeconds: 180,
          seed: 42,
          players: ["openrouter:test/model", "human"],
        },
        player: {
          id: "openrouter:test/model",
          label: "Synthetic provider fixture",
          source: "openrouter",
        },
        speciesDir,
      },
      (m, worker) => {
        if (m.type === "model_request") {
          requests++;
          worker.postMessage({
            type: "model_command",
            error: "provider_unavailable",
          });
        }
      },
    );
    expect(requests).toBe(1);
    expect(result.providerError).toBe(true);
    expect(result.frame.completedAt).toBeNull();
    expect(result.decisions).toBe(0);
  });
});
