import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SOAK_FLOOR, SOAK_POPULATION, runSoak, type SoakResult } from '../src/soak.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

/**
 * Five world-years. The one-year gate cannot see a predator-prey collapse: every version of
 * this forest that emptied did so in its third or fourth year, after passing that gate. This
 * takes around twenty minutes, so it runs on request: VANA_LONG_SOAK=1 npx vitest run soak-long
 */
const DAYS = 1800;
const PREY = ['chital', 'sambar', 'gaur', 'langur', 'boar', 'hare', 'squirrel'];

describe.skipIf(process.env.VANA_LONG_SOAK !== '1')('long soak gate', () => {
  let result: SoakResult;
  beforeAll(() => { result = runSoak({ seed: 1, days: DAYS, speciesDir }); }, 3_600_000);

  it('completes without a hard failure', () => {
    expect(result.failures).toEqual([]);
  });

  it('ends with no species pinned at its viability floor', () => {
    for (const [speciesId, floor] of Object.entries(SOAK_FLOOR)) {
      expect(result.finalPopulation[speciesId], speciesId).toBeGreaterThan(floor);
    }
  });

  it('keeps every prey species at two-fifths or more of the density it was seeded at', () => {
    for (const speciesId of PREY) {
      expect(result.finalPopulation[speciesId], speciesId)
        .toBeGreaterThanOrEqual(SOAK_POPULATION[speciesId]! * 0.4);
    }
  });

  it('is sustained by births, not by what walks in from outside', () => {
    expect(result.births).toBeGreaterThan(result.immigrationEvents * 3);
  });
});
