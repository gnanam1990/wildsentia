import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NUTRIENT_PER_KG_BIOMASS, isIslandProfile, type CommunityProfile, type TerrainProfile } from '@vana/shared';
import { islandPopulation, loadSpeciesDir } from '@vana/sim';
import { SOAK_FLOOR, SOAK_POPULATION, gatedYoungThirst, runSoak, type SoakResult } from '../src/soak.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

/**
 * Multi-year gates. The one-year gate cannot see a predator-prey collapse: every version of
 * this forest that emptied did so in its third or fourth year, after passing that gate. These
 * run on request only:
 *
 *   VANA_LONG_SOAK=1 npx vitest run soak-long
 *     five world-years of the mainland forest, seed 1 (about twenty minutes)
 *
 *   VANA_LONG_SOAK=1 VANA_LONG_SOAK_TERRAIN=island_v1 VANA_LONG_SOAK_DAYS=1080 \
 *   VANA_LONG_SOAK_SEEDS=1,2,3 VANA_LONG_SOAK_OUTPUT=.ci-artifacts/multi-year npx vitest run soak-long
 *     the closed island the live server boots (with its household), three world-years per
 *     seed; the full report of each seed is written as evidence JSON
 */
const env = process.env;
const TERRAIN = (env.VANA_LONG_SOAK_TERRAIN ?? 'mainland') as TerrainProfile;
const ISLAND = isIslandProfile(TERRAIN);
const FOUNDING = ISLAND ? islandPopulation(TERRAIN as 'island_v1' | 'island_v2') : {};
const COMMUNITY = (env.VANA_LONG_SOAK_COMMUNITY ?? (ISLAND ? 'household_v1' : 'none')) as CommunityProfile;
const DAYS = Number(env.VANA_LONG_SOAK_DAYS ?? 1800);
const SEEDS = (env.VANA_LONG_SOAK_SEEDS ?? '1').split(',').map(Number);
const OUTPUT = env.VANA_LONG_SOAK_OUTPUT;
const PREY = ['chital', 'sambar', 'gaur', 'langur', 'boar', 'hare', 'squirrel'];
/**
 * Island prey floor: no prey species ends any world-year below a quarter of its founding count.
 * A fall of more than three quarters in three years is a collapse, not a fluctuation. This is a
 * stated acceptance line, not a calibrated carrying capacity.
 */
const ISLAND_PREY_FLOOR = 0.25;
const ARRIVING = new Set([...loadSpeciesDir(speciesDir).values()].filter(cfg => cfg.islandArrival).map(cfg => cfg.id));

describe.skipIf(env.VANA_LONG_SOAK !== '1')(`long soak gate (${TERRAIN}, ${DAYS} days)`, () => {
  const results: SoakResult[] = [];
  beforeAll(() => {
    for (const seed of SEEDS) {
      const result = runSoak({ seed, days: DAYS, speciesDir, terrainProfile: TERRAIN, communityProfile: COMMUNITY });
      results.push(result);
      if (OUTPUT) {
        mkdirSync(OUTPUT, { recursive: true });
        writeFileSync(join(OUTPUT, `soak-${result.simVersion}-${TERRAIN}-seed${seed}-${DAYS}d.json`),
          JSON.stringify(result, null, 2) + '\n');
      }
    }
  }, 3 * 3_600_000);

  it('completes every requested day without a hard failure', () => {
    for (const result of results) {
      expect(result.completedDays, `seed ${result.seed}`).toBe(DAYS);
      expect(result.failures, `seed ${result.seed}`).toEqual([]);
    }
  });

  it('keeps every species alive at the end of every world-year', () => {
    for (const result of results) for (const year of result.years) {
      expect(year.extinct, `seed ${result.seed} year ${year.year}`).toEqual([]);
    }
  });

  it('conserves nutrients through birth, death, scavenging and decay', () => {
    for (const result of results) expect(result.nutrientDrift, `seed ${result.seed}`).toBeLessThan(0.01);
  });

  it('is sustained by births, not by what walks in from outside', () => {
    for (const result of results) {
      expect(result.births, `seed ${result.seed}`).toBeGreaterThan(result.immigrationEvents * 3);
    }
  });

  // sim_0.33.0: a closed island admits only recorded crossings by species that swim to islands,
  // each a positioned event whose body the nutrient ledger imports. Nothing else walks in.
  it.skipIf(!ISLAND)('admits only recorded island crossings, each accounted for in the ledgers', () => {
    for (const result of results) {
      const label = `seed ${result.seed}`;
      expect(Object.keys(result.immigrationByRoute).filter(route => route !== 'island_crossing'), label).toEqual([]);
      expect(result.islandArrivals.length, label).toBe(result.immigrationEvents);
      for (const arrival of result.islandArrivals) {
        expect(ARRIVING.has(arrival.species), `${label} ${arrival.species}`).toBe(true);
        expect(arrival.positioned, `${label} ${arrival.actorId}`).toBe(true);
      }
      const imported = result.islandArrivals.reduce((kg, a) => kg + a.massKg, 0) * NUTRIENT_PER_KG_BIOMASS;
      expect(result.importedNutrient, label).toBeCloseTo(imported, 6);
      for (const year of result.years)
        expect(Object.values(year.arrivals).reduce((n, v) => n + v, 0), `${label} year ${year.year}`)
          .toBe(result.islandArrivals.filter(a => a.worldTime > year.startDay * 86400 && a.worldTime <= year.endDay * 86400).length);
    }
  });

  it.skipIf(!ISLAND)(`keeps every prey species at ${ISLAND_PREY_FLOOR * 100}% or more of its founding count at every year end`, () => {
    for (const result of results) for (const year of result.years) for (const speciesId of PREY) {
      expect(year.population[speciesId], `seed ${result.seed} year ${year.year} ${speciesId}`)
        .toBeGreaterThanOrEqual(FOUNDING[speciesId]! * ISLAND_PREY_FLOOR);
    }
  });

  // A dependent may starve with its mother in a famine, or die when she is killed. What it
  // should not do is die of thirst while a living, watered parent is out of reach (the care
  // failure sim_0.32.0 removed). Starvation with a living parent is reported, not gated.
  // sim_0.37.0 (owner's decision): so is a thirst death whose parent was herself starving, or kept
  // from care by a predator, over the hours before it (careContext.ts). Those are listed in
  // `ecologicalYoungThirst`; every other one is a care failure and fails here.
  it.skipIf(!ISLAND)('loses no dependent young to thirst while its fed, unthreatened parent is alive but out of reach', () => {
    for (const result of results) {
      const remote = gatedYoungThirst(result.youngDeprivationWithParent);
      expect(remote.map(r => `${r.species}/${r.cause} ${r.childId} at ${r.parentDistanceM?.toFixed(0)} m`),
        `seed ${result.seed}`).toEqual([]);
    }
  });

  it.skipIf(ISLAND)('ends with no species pinned at its viability floor', () => {
    for (const result of results) for (const [speciesId, floor] of Object.entries(SOAK_FLOOR)) {
      expect(result.finalPopulation[speciesId], speciesId).toBeGreaterThan(floor);
    }
  });

  it.skipIf(ISLAND)('keeps every prey species at two-fifths or more of the density it was seeded at', () => {
    for (const result of results) for (const speciesId of PREY) {
      expect(result.finalPopulation[speciesId], speciesId)
        .toBeGreaterThanOrEqual(SOAK_POPULATION[speciesId]! * 0.4);
    }
  });
});
