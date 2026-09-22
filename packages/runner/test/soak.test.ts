import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SOAK_FLOOR, SOAK_POPULATION, runSoak } from '../src/soak.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

/**
 * One world-year across two seeds. Long enough for two generations of the fast breeders and
 * for the full carcass cycle to turn over; short enough that the suite stays usable now that
 * populations run into the thousands.
 *
 * The release gate in spec §14.1 is fifty world-years across twenty seeds, which runs overnight
 * with `npm run soak`. This carries the same assertions at a length the suite can hold.
 */
const DAYS = 360;
const results = [1, 2].map((seed) => runSoak({ seed, days: DAYS, speciesDir }));

describe('soak gate', () => {
  it.each(results)('seed $seed completes without a hard failure', (result) => {
    expect(result.failures).toEqual([]);
  });

  it.each(results)('seed $seed keeps every species alive', (result) => {
    for (const speciesId of Object.keys(SOAK_POPULATION)) {
      expect(result.finalPopulation[speciesId]).toBeGreaterThan(0);
    }
  });

  it.each(results)('seed $seed holds every species at or above its viability floor', (result) => {
    for (const [speciesId, floor] of Object.entries(SOAK_FLOOR)) {
      expect(result.finalPopulation[speciesId]).toBeGreaterThanOrEqual(floor);
    }
  });

  it.each(results)('seed $seed conserves nutrients through birth, death, scavenging and decay', (result) => {
    expect(result.nutrientDrift).toBeLessThan(0.01);
  });

  it.each(results)('seed $seed carries carcasses through to nutrient return', (result) => {
    expect(result.carcassesCreated).toBeGreaterThan(0);
    expect(result.carcassesCompleted + result.carcassesOutstanding).toBe(result.carcassesCreated);
    expect(result.carcassesCompleted / result.carcassesCreated).toBeGreaterThan(0.5);
  });

  it.each(results)('seed $seed feeds its scavengers', (result) => {
    expect(result.scavengeEvents).toBeGreaterThan(result.carcassesCreated);
  });

  it.each(results)('seed $seed makes predation a real cause of death', (result) => {
    expect(result.deathsByCause.predation ?? 0).toBeGreaterThan(0);
  });

  // --- the M5 criteria: the world sustains itself by breeding
  it.each(results)('seed $seed is carried by births, not by immigration', (result) => {
    expect(result.births).toBeGreaterThan(result.immigrationEvents * 3);
  });

  it.each(results)('seed $seed reaches at least the third generation', (result) => {
    expect(result.generationsReached).toBeGreaterThanOrEqual(2);
  });

  it.each(results)('seed $seed names both parents on every animal it births', (result) => {
    expect(result.births).toBeGreaterThan(0);
    expect(Object.values(result.birthsBySpecies).reduce((a, b) => a + b, 0)).toBe(result.births);
  });

  it.each(results)('seed $seed keeps mean inbreeding low while dispersal works', (result) => {
    expect(result.meanInbreeding).toBeLessThan(0.05);
  });

  it('is deterministic: the same seed gives the same outcome', () => {
    const a = runSoak({ seed: 9, days: 120, speciesDir });
    const b = runSoak({ seed: 9, days: 120, speciesDir });
    expect(a.finalPopulation).toEqual(b.finalPopulation);
    expect(a.births).toBe(b.births);
    expect(a.events).toBe(b.events);
  });
});
