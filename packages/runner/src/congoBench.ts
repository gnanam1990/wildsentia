import { fileURLToPath } from 'node:url';
import { CONGO_POPULATION, createWorld, takeSnapshot } from '@vana/sim';

/**
 * The Congo forest's speed budget (spec §1): one world hour of the founding population in ≤ 2 s.
 * Since 1B it founds the real Congo species at their field densities (CONGO_POPULATION).
 */
export interface CongoBenchResult {
  animals: number; foundingMs: number; hourMs: { median: number; p95: number; max: number };
  heapMb: number; snapshotMb: number; snapshotMs: number;
}

/** The Congo founding population (blue duiker, water chevrotain, African leopard). */
export const CONGO_BENCH_POPULATION = CONGO_POPULATION;
export const CONGO_HOUR_BUDGET_MS = 2_000;

const SPECIES_DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

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
    measureHours: Number(process.env.MEASURE_HOURS ?? 24), population: { ...CONGO_BENCH_POPULATION } });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.hourMs.p95 <= CONGO_HOUR_BUDGET_MS ? 0 : 1;
}
