import { createWorld } from '@vana/sim';

export interface SoakResult {
  seed: number;
  days: number;
  finalPopulation: Record<string, number>;
  events: number;
  nutrientDrift: number;
  failures: string[];
}

export interface SoakOptions {
  seed: number;
  days: number;
  speciesDir: string;
}

export function runSoak({ seed, days, speciesDir }: SoakOptions): SoakResult {
  const world = createWorld({
    seed,
    speciesDir,
    initialAgents: { sambar: 60 },
    minPopulation: { sambar: 15 },
  });

  const baseline = world.totalNutrients();
  const failures: string[] = [];

  for (let day = 0; day < days; day++) {
    for (let hour = 0; hour < 24; hour++) world.step(1);

    if (day % 10 === 0) {
      for (const p of world.patches) {
        if (!Number.isFinite(p.plant.grass) || p.plant.grass < 0) {
          failures.push(`day ${day}: patch ${p.id} grass=${p.plant.grass}`);
        }
        if (!Number.isFinite(p.soilNutrients) || p.soilNutrients < 0) {
          failures.push(`day ${day}: patch ${p.id} soilNutrients=${p.soilNutrients}`);
        }
      }
      if (world.livingCount('sambar') === 0) failures.push(`day ${day}: sambar extinct`);
    }
    if (failures.length > 0) break;
  }

  const finalPopulation: Record<string, number> = {};
  for (const speciesId of world.species.keys()) {
    finalPopulation[speciesId] = world.livingCount(speciesId);
  }

  return {
    seed,
    days,
    finalPopulation,
    events: world.log.size(),
    nutrientDrift: Math.abs(world.totalNutrients() - baseline),
    failures,
  };
}

// CLI entry: `npm run soak -- --seed 1 --days 1000`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string, fallback: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const started = Date.now();
  const result = runSoak({
    seed: arg('seed', 1),
    days: arg('days', 1000),
    speciesDir: new URL('../../../config/species', import.meta.url).pathname,
  });
  console.log(JSON.stringify({ ...result, wallClockMs: Date.now() - started }, null, 2));
  process.exit(result.failures.length === 0 ? 0 : 1);
}
