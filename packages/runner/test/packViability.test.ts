import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runSoak } from '../src/soak.js';
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
// Always run the actual deployed profile. Historical island_v1 evidence cannot validate it.
describe('island_v2 pack viability regression', () => {
  it.each([1, 2, 3])('keeps every species alive and conserves the ledgers for 90 days (seed %i)', seed => {
    const result = runSoak({ seed, days: 90, speciesDir, terrainProfile: 'island_v2', communityProfile: 'household_v1' });
    expect(result.completedDays).toBe(90);
    expect(result.failures).toEqual([]);
    for (const [species, population] of Object.entries(result.finalPopulation)) expect(population, species).toBeGreaterThan(0);
    expect(result.nutrientDrift).toBeLessThan(0.01);
    expect(result.islandArrivals.some(arrival => arrival.species === 'dhole')).toBe(false);
  });
});
