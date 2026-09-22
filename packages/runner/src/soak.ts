import { carcassMass } from '@vana/shared';
import { createWorld } from '@vana/sim';

/**
 * Standing populations for the soak, sized from the energy pyramid in spec §6.2: roughly
 * 300-500 prey animals per resident tiger across a 36 km² grid, with the herbivores in turn
 * cropping well under a third of net primary production.
 */
export const SOAK_POPULATION: Record<string, number> = {
  chital: 260, sambar: 150, hare: 400, langur: 140, squirrel: 120, boar: 140,
  gaur: 60, elephant: 6,
  tiger: 4, dhole: 12,
  jackal: 35, vulture: 20,
};

/**
 * Intended carrying capacity for a 36 km² world, from published field densities: hares at
 * tens per km², chital at twenty-odd in good habitat, sambar nearer five, gaur two to five,
 * tigers around 0.12, dhole in packs at roughly 0.2.
 *
 * This is deliberately separate from the seed count above. Once animals breed, the number a
 * population settles at is set by the land, not by how many were placed at the start, and
 * measuring "too many" against the seed count would flag a healthy recovery as a failure.
 */
export const SOAK_CEILING: Record<string, number> = {
  chital: 900, sambar: 550, hare: 1400, langur: 400, squirrel: 450, boar: 500,
  gaur: 260, elephant: 40,
  tiger: 14, dhole: 40,
  jackal: 200, vulture: 90,
};

/**
 * Minimum viable population. Below this a species is rescued by dispersal from off-map
 * (spec §6.5), because a closed 36 km² patch of a much larger landscape would not really be
 * the last refuge of anything.
 *
 * These are floors, not targets. A healthy run should sit well above them and touch them rarely;
 * heavy immigration is a signal that breeding is not carrying the population.
 */
export const SOAK_FLOOR: Record<string, number> = {
  chital: 30, sambar: 20, hare: 40, langur: 20, squirrel: 20, boar: 20,
  gaur: 10, elephant: 3,
  tiger: 2, dhole: 4,
  jackal: 6, vulture: 4,
};

export interface SoakResult {
  seed: number;
  days: number;
  finalPopulation: Record<string, number>;
  peakPopulation: Record<string, number>;
  events: number;
  nutrientDrift: number;
  huntAttempts: number;
  huntSuccessRate: number;
  births: number;
  birthsBySpecies: Record<string, number>;
  deathsBySpecies: Record<string, number>;
  courtshipAttempts: number;
  courtshipBySpecies: Record<string, number>;
  courtshipSuccessRate: number;
  generationsReached: number;
  meanInbreeding: number;
  immigrationEvents: number;
  carcassesCreated: number;
  carcassesCompleted: number;
  carcassesOutstanding: number;
  scavengeEvents: number;
  deathsByCause: Record<string, number>;
  failures: string[];
  /** Populations outside their intended band: unfinished balancing, not a defect. */
  warnings: string[];
  wallClockMs: number;
}

const MAX_RECORDED_FAILURES = 40;

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
    retainEvents: 200_000,
  });

  let huntAttempts = 0;
  let huntKills = 0;
  let carcassesCreated = 0;
  let carcassesCompleted = 0;
  let scavengeEvents = 0;
  let immigrationEvents = 0;
  const deathsByCause: Record<string, number> = {};
  const birthsBySpecies: Record<string, number> = {};
  const deathsBySpecies: Record<string, number> = {};
  const courtship = { attempts: 0, successes: 0 };
  const courtshipBySpecies: Record<string, number> = {};

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
        case 'immigration': immigrationEvents++; break;
        case 'born': {
          const id = String(event.conditions.species ?? '?');
          birthsBySpecies[id] = (birthsBySpecies[id] ?? 0) + 1;
          break;
        }
        case 'courtship': {
          courtship.attempts++;
          if (event.outcome === 'success') courtship.successes++;
          const sp = String(event.conditions.species ?? '?');
          courtshipBySpecies[sp] = (courtshipBySpecies[sp] ?? 0) + 1;
          if (event.outcome === 'success') {
            courtshipBySpecies[`${sp}/ok`] = (courtshipBySpecies[`${sp}/ok`] ?? 0) + 1;
          }
          break;
        }
        case 'died': {
          const cause = String(event.conditions.cause ?? 'unknown');
          deathsByCause[cause] = (deathsByCause[cause] ?? 0) + 1;
          const who = event.actors[0]?.split('_')[0] ?? '?';
          deathsBySpecies[who] = (deathsBySpecies[who] ?? 0) + 1;
          const key = `${who}/${cause}`;
          deathsBySpecies[key] = (deathsBySpecies[key] ?? 0) + 1;
          break;
        }
        default: break;
      }
    }
  };

  const baseline = world.totalNutrients();
  const failures: string[] = [];
  const warnings: string[] = [];
  const warned = new Set<string>();
  const peakPopulation: Record<string, number> = {};

  for (let day = 0; day < days; day++) {
    for (let hour = 0; hour < 24; hour++) { world.step(1); tally(); }

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
      peakPopulation[speciesId] = Math.max(peakPopulation[speciesId] ?? 0, living);
      if (living === 0) failures.push(`day ${day}: ${speciesId} extinct`);
      const ceiling = SOAK_CEILING[speciesId];
      if (ceiling !== undefined && living > ceiling && !warned.has(speciesId)) {
        warned.add(speciesId);
        warnings.push(`${speciesId} peaked over its intended ceiling of ${ceiling} (first seen day ${day})`);
      }
    }
    for (const carcass of world.carcasses) {
      if (carcassMass(carcass.biomass) < -1e-6) {
        failures.push(`day ${day}: carcass ${carcass.id} has negative mass`);
      }
    }
    // Record and keep going. Stopping at the first breach hides everything that happens after
    // it, and an overshoot that corrects itself is a different finding from one that does not.
    if (failures.length > MAX_RECORDED_FAILURES) {
      failures.push(`stopped recording after ${MAX_RECORDED_FAILURES} failures`);
      break;
    }
  }

  tally();

  const finalPopulation: Record<string, number> = {};
  for (const speciesId of world.species.keys()) {
    finalPopulation[speciesId] = world.livingCount(speciesId);
  }

  // Inbreeding across every living pair of parents currently in the world.
  let inbreedingTotal = 0;
  let inbreedingSamples = 0;
  let generationsReached = 0;
  for (const agent of world.agents) {
    if (!agent.alive) continue;
    generationsReached = Math.max(generationsReached, agent.generation);
    if (agent.motherId !== null && agent.fatherId !== null) {
      inbreedingTotal += world.pedigree.coefficientFor(agent.motherId, agent.fatherId);
      inbreedingSamples++;
    }
  }

  return {
    seed, days, finalPopulation, peakPopulation,
    births: world.births,
    birthsBySpecies,
    deathsBySpecies,
    courtshipAttempts: courtship.attempts,
    courtshipBySpecies,
    courtshipSuccessRate: courtship.attempts === 0 ? 0 : courtship.successes / courtship.attempts,
    generationsReached,
    meanInbreeding: inbreedingSamples === 0 ? 0 : inbreedingTotal / inbreedingSamples,
    immigrationEvents,
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
    warnings,
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
