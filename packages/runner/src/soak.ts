import { carcassMass } from '@vana/shared';
import { createWorld } from '@vana/sim';

/**
 * Standing populations for the soak, sized from the energy pyramid in spec §6.2: roughly
 * 300-500 prey animals per resident tiger across a 36 km² grid, with the herbivores in turn
 * cropping well under a third of net primary production.
 */
export const SOAK_POPULATION: Record<string, number> = {
  chital: 200, sambar: 120, hare: 150, langur: 80, squirrel: 60, boar: 60,
  gaur: 30, elephant: 4,
  tiger: 3, dhole: 8,
  jackal: 15, vulture: 12,
};

/** Immigration floors. A species dipping below its floor is rescued from off-map (spec §6.5). */
export const SOAK_FLOOR: Record<string, number> = Object.fromEntries(
  Object.entries(SOAK_POPULATION).map(([id, n]) => [id, Math.max(2, Math.round(n * 0.4))]),
);

export interface SoakResult {
  seed: number;
  days: number;
  finalPopulation: Record<string, number>;
  events: number;
  nutrientDrift: number;
  huntAttempts: number;
  huntSuccessRate: number;
  carcassesCreated: number;
  carcassesCompleted: number;
  carcassesOutstanding: number;
  scavengeEvents: number;
  deathsByCause: Record<string, number>;
  failures: string[];
  wallClockMs: number;
}

export interface SoakOptions {
  seed: number;
  days: number;
  speciesDir: string;
}

export function runSoak({ seed, days, speciesDir }: SoakOptions): SoakResult {
  const started = Date.now();
  const world = createWorld({
    seed, speciesDir,
    initialAgents: SOAK_POPULATION,
    minPopulation: SOAK_FLOOR,
    // A fifty-year run emits hundreds of millions of events. Keep a small window and tally
    // as we go; the numbers below are counted, never reconstructed from a retained array.
    retainEvents: 20_000,
  });

  let huntAttempts = 0;
  let huntKills = 0;
  let carcassesCreated = 0;
  let carcassesCompleted = 0;
  let scavengeEvents = 0;
  const deathsByCause: Record<string, number> = {};

  const tally = (): void => {
    for (const event of world.log.take()) {
      switch (event.type) {
        case 'hunt':
          huntAttempts++;
          if (event.outcome === 'success') huntKills++;
          break;
        case 'carcass_created': carcassesCreated++; break;
        case 'nutrients_returned': carcassesCompleted++; break;
        case 'scavenged': if (event.outcome === 'success') scavengeEvents++; break;
        case 'died': {
          const cause = String(event.conditions.cause ?? 'unknown');
          deathsByCause[cause] = (deathsByCause[cause] ?? 0) + 1;
          break;
        }
        default: break;
      }
    }
  };

  const baseline = world.totalNutrients();
  const failures: string[] = [];

  for (let day = 0; day < days; day++) {
    for (let hour = 0; hour < 24; hour++) world.step(1);
    tally();

    if (day % 10 !== 0) continue;

    for (const p of world.patches) {
      if (!Number.isFinite(p.plant.grass) || p.plant.grass < 0) {
        failures.push(`day ${day}: patch ${p.id} grass=${p.plant.grass}`);
      }
      if (!Number.isFinite(p.soilNutrients) || p.soilNutrients < 0) {
        failures.push(`day ${day}: patch ${p.id} soilNutrients=${p.soilNutrients}`);
      }
    }
    for (const speciesId of world.species.keys()) {
      const living = world.livingCount(speciesId);
      if (living === 0) failures.push(`day ${day}: ${speciesId} extinct`);
      const ceiling = (SOAK_POPULATION[speciesId] ?? 0) * 3;
      if (ceiling > 0 && living > ceiling) {
        failures.push(`day ${day}: ${speciesId} at ${living}, over 3x its intended ${SOAK_POPULATION[speciesId]}`);
      }
    }
    for (const carcass of world.carcasses) {
      if (carcassMass(carcass.biomass) < -1e-6) {
        failures.push(`day ${day}: carcass ${carcass.id} has negative mass`);
      }
    }
    if (failures.length > 0) break;
  }

  tally();

  const finalPopulation: Record<string, number> = {};
  for (const speciesId of world.species.keys()) {
    finalPopulation[speciesId] = world.livingCount(speciesId);
  }

  return {
    seed, days, finalPopulation,
    events: world.log.size(),
    nutrientDrift: Math.abs(world.totalNutrients() - baseline),
    huntAttempts,
    huntSuccessRate: huntAttempts === 0 ? 0 : huntKills / huntAttempts,
    carcassesCreated,
    carcassesCompleted,
    carcassesOutstanding: world.carcasses.length,
    scavengeEvents,
    deathsByCause,
    failures,
    wallClockMs: Date.now() - started,
  };
}

// CLI entry: `npm run soak -- --seed 1 --days 1000`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string, fallback: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const result = runSoak({
    seed: arg('seed', 1),
    days: arg('days', 1000),
    speciesDir: new URL('../../../config/species', import.meta.url).pathname,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failures.length === 0 ? 0 : 1);
}
