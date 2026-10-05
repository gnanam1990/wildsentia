import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommunityProfile, TerrainProfile } from '@vana/shared';
import { SOAK_FLOOR, SOAK_POPULATION, runSoak, type SoakResult } from '../src/soak.js';

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
const ISLAND = TERRAIN === 'island_v1';
const COMMUNITY = (env.VANA_LONG_SOAK_COMMUNITY ?? (ISLAND ? 'household_v1' : 'none')) as CommunityProfile;
const DAYS = Number(env.VANA_LONG_SOAK_DAYS ?? 1800);
const SEEDS = (env.VANA_LONG_SOAK_SEEDS ?? '1').split(',').map(Number);
const OUTPUT = env.VANA_LONG_SOAK_OUTPUT;
const PREY = ['chital', 'sambar', 'gaur', 'langur', 'boar', 'hare', 'squirrel'];

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
      if (ISLAND) expect(result.immigrationEvents, `seed ${result.seed}`).toBe(0);
    }
  });

  // A dependent may starve with its mother in a famine, or die when she is killed. What it
  // should not do is die of thirst while a living, watered parent is out of reach (the care
  // failure sim_0.32.0 removed). Starvation with a living parent is reported, not gated.
  it.skipIf(!ISLAND)('loses no dependent young to thirst while its parent is alive but out of reach', () => {
    for (const result of results) {
      const remote = result.youngDeprivationWithParent
        .filter(record => record.cause === 'dehydration' && record.contact !== 'near');
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
