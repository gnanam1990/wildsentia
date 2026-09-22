import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SOAK_FLOOR, SOAK_POPULATION, runSoak } from '../src/soak.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

/**
 * Two world-years across three seeds. The full release gate in spec §14.1 is fifty world-years
 * across twenty seeds, which runs overnight via `npm run soak`; this keeps the same assertions
 * at a length the test suite can carry.
 */
const DAYS = 720;
const SEEDS = [1, 2, 3];
const results = SEEDS.map((seed) => runSoak({ seed, days: DAYS, speciesDir }));

describe('M4 soak gate', () => {
  it.each(results)('seed $seed completes without a failure', (result) => {
    expect(result.failures).toEqual([]);
  });

  it.each(results)('seed $seed keeps every species alive', (result) => {
    for (const speciesId of Object.keys(SOAK_POPULATION)) {
      expect(result.finalPopulation[speciesId]).toBeGreaterThan(0);
    }
  });

  it.each(results)('seed $seed holds every species at or above its immigration floor', (result) => {
    for (const [speciesId, floor] of Object.entries(SOAK_FLOOR)) {
      expect(result.finalPopulation[speciesId]).toBeGreaterThanOrEqual(floor);
    }
  });

  it.each(results)('seed $seed keeps hunt success inside the 20-35% band', (result) => {
    expect(result.huntAttempts).toBeGreaterThan(100);
    expect(result.huntSuccessRate).toBeGreaterThanOrEqual(0.2);
    expect(result.huntSuccessRate).toBeLessThanOrEqual(0.35);
  });

  it.each(results)('seed $seed conserves nutrients through death, scavenging and decay', (result) => {
    expect(result.nutrientDrift).toBeLessThan(0.01);
  });

  it.each(results)('seed $seed carries most carcasses all the way to nutrient return', (result) => {
    expect(result.carcassesCreated).toBeGreaterThan(0);
    // Outstanding carcasses are simply ones still decaying at the moment the run stopped.
    expect(result.carcassesCompleted + result.carcassesOutstanding).toBe(result.carcassesCreated);
    expect(result.carcassesCompleted / result.carcassesCreated).toBeGreaterThan(0.5);
  });

  it.each(results)('seed $seed feeds its scavengers', (result) => {
    expect(result.scavengeEvents).toBeGreaterThan(result.carcassesCreated);
  });

  it.each(results)('seed $seed makes predation a leading cause of death', (result) => {
    const predation = result.deathsByCause.predation ?? 0;
    expect(predation).toBeGreaterThan(0);
    const total = Object.values(result.deathsByCause).reduce((a, b) => a + b, 0);
    expect(predation / total).toBeGreaterThan(0.2);
  });

  it('is deterministic: the same seed gives the same outcome', () => {
    const a = runSoak({ seed: 9, days: 120, speciesDir });
    const b = runSoak({ seed: 9, days: 120, speciesDir });
    expect(a.finalPopulation).toEqual(b.finalPopulation);
    expect(a.huntAttempts).toBe(b.huntAttempts);
    expect(a.events).toBe(b.events);
  });
});
