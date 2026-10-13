import { fileURLToPath } from 'node:url';
import { createWorld, takeSnapshot } from '@vana/sim';

/**
 * The Congo forest's speed budget (spec §1): one world hour of the founding population in ≤ 2 s.
 * The Congo species do not exist yet (sub-project 1B), so the benchmark founds stand-ins of the
 * same number from the island's roster. Stand-ins appear only here, never in a served world.
 */
export interface CongoBenchResult {
  animals: number; foundingMs: number; hourMs: { median: number; p95: number; max: number };
  heapMb: number; snapshotMb: number; snapshotMs: number;
}

/** The spec's sizing: ~45k small forest prey, ~3k larger prey along water, ~150 leopards. */
export const CONGO_STAND_IN = { hare: 45_000, chital: 3_000, leopard: 150 } as const;
export const CONGO_HOUR_BUDGET_MS = 2_000;

const SPECIES_DIR = fileURLToPath(new URL('../../../config/species', import.meta.url));

export function runCongoBench(o: { seed: number; warmHours: number; measureHours: number; population: Record<string, number> }): CongoBenchResult {
  let t = performance.now();
  const world = createWorld({ seed: o.seed, speciesDir: SPECIES_DIR, terrainProfile: 'congo_v1', initialAgents: o.population, minPopulation: {}, retainEvents: 5_000 });
  const foundingMs = performance.now() - t;
  world.step(o.warmHours);
  const hours: number[] = [];
  for (let h = 0; h < o.measureHours; h++) { t = performance.now(); world.step(1); hours.push(performance.now() - t); }
  hours.sort((a, b) => a - b);
  t = performance.now();
  const json = JSON.stringify(takeSnapshot(world));
  const snapshotMs = performance.now() - t;
  return {
    animals: world.agents.filter((a) => a.alive).length, foundingMs,
    hourMs: { median: hours[Math.floor(hours.length / 2)]!, p95: hours[Math.min(hours.length - 1, Math.ceil(hours.length * 0.95) - 1)]!, max: hours.at(-1)! },
    heapMb: process.memoryUsage().heapUsed / 1_048_576, snapshotMb: Buffer.byteLength(json) / 1_048_576, snapshotMs,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runCongoBench({ seed: Number(process.env.SEED ?? 7), warmHours: Number(process.env.WARM_HOURS ?? 24),
    measureHours: Number(process.env.MEASURE_HOURS ?? 24), population: { ...CONGO_STAND_IN } });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.hourMs.p95 <= CONGO_HOUR_BUDGET_MS ? 0 : 1;
}
