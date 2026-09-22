import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runSoak } from '../src/soak.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

describe('soak runner', () => {
  it('survives 1000 world-days with no failures', () => {
    const result = runSoak({ seed: 1, days: 1000, speciesDir });
    expect(result.failures).toEqual([]);
    expect(result.finalPopulation.sambar).toBeGreaterThan(0);
    expect(result.events).toBeGreaterThan(1000);
  });

  it('holds the nutrient invariant across 1000 world-days', () => {
    expect(runSoak({ seed: 1, days: 1000, speciesDir }).nutrientDrift).toBeLessThan(0.01);
  });

  it('survives across several seeds', () => {
    for (const seed of [2, 3, 4]) {
      expect(runSoak({ seed, days: 300, speciesDir }).failures).toEqual([]);
    }
  });
});
