import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { recordPopulationPeaks } from '../src/populationMetrics.js';
import { recordCourtshipByOutcomeReason, recordDeprivationBySpeciesCare, runSoak, SOAK_POPULATION } from '../src/soak.js';
import type { WorldEvent } from '@vana/shared';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

describe('soak evidence accuracy', () => {
  it('retains a transient hourly peak and the starting population after a decline', () => {
    const peaks: Record<string, number> = {};
    for (const count of [500, 490, 900, 510]) recordPopulationPeaks(peaks, ['boar'], () => count);
    expect(peaks.boar).toBe(900);
    recordPopulationPeaks(peaks, ['boar', 'tiger'], (id) => id === 'boar' ? 0 : 4);
    expect(peaks).toEqual({ boar: 900, tiger: 4 });
  });

  it('includes initial and final populations in a real short run', () => {
    const result = runSoak({ seed: 1, days: 1, speciesDir });
    expect(result.completedDays).toBe(1); expect(result.completedWorldTime).toBe(86400); expect(result.stoppedEarly).toBe(false);
    expect(result.community).toEqual({ profile: 'none', rulesVersion: null, deathRecords: [], alive: 0, deaths: 0,
      repairs: 0, homeCondition: null, conceptions: 0, births: 0, pregnancyLosses: 0, careEvents: 0,
      careFoodKg: 0, careWaterL: 0, childrenAlive: 0, childrenDead: 0,
      storms: 0, floods: 0, collapses: 0, rebuilds: 0 });
    const food = result.packFood;
    expect(food.collectedKg).toBeCloseTo(food.deliveredKg + food.digestedKg + food.releasedOnDeathKg
      + food.exportedKg + food.outstandingKg, 6);
    expect(food.deliveries).toBe(food.nursingParentDeliveries + food.youngDeliveries);
    expect(Object.values(food).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    const hunts = Object.values(result.huntsBySpecies);
    expect(hunts.reduce((sum, h) => sum + h.attempts, 0)).toBe(result.huntAttempts);
    expect(hunts.reduce((sum, h) => sum + h.kills, 0)).toBeCloseTo(result.huntAttempts * result.huntSuccessRate);
    const sum = (values: Record<string, number>) => Object.values(values).reduce((n, v) => n + v, 0);
    expect(sum(result.courtshipBySpeciesOutcomeReason)).toBe(result.courtshipAttempts);
    expect(sum(result.starvationByLifeStage)).toBe(result.deathsByCause.starvation ?? 0);
    expect(sum(result.dehydrationByLifeStage)).toBe(result.deathsByCause.dehydration ?? 0);
    expect(sum(result.deprivationByCare)).toBe((result.deathsByCause.starvation ?? 0) + (result.deathsByCause.dehydration ?? 0));
    expect(sum(result.deprivationBySpeciesCare)).toBe(sum(result.deprivationByCare));
    expect(result.floweringEvents).toMatchObject({ blooms: 0, visitationSettlements: 0,
      seedMaturations: 0, recruitments: 0, seedLosses: 0 });
    for (const id of Object.keys(SOAK_POPULATION)) {
      expect(result.peakPopulation[id], id).toBeGreaterThanOrEqual(SOAK_POPULATION[id]!);
      expect(result.peakPopulation[id], id).toBeGreaterThanOrEqual(result.finalPopulation[id]!);
    }
  });

  it('cross-tabulates species, deprivation cause and care state from death facts only', () => {
    const tally: Record<string, number> = {};
    const event = (species: string, cause: string, careState: string): WorldEvent => ({
      id: 'test', type: 'died', worldTime: 0, simVersion: 'test', patchId: 0,
      actors: ['misleading_id'], conditions: { species, cause, careState }, outcome: 'success',
      effects: {}, causalParents: [], confidence: 'authoritative',
    });
    for (const death of [event('boar', 'starvation', 'unweaned_without_parent'),
      event('boar', 'dehydration', 'unweaned_with_parent'),
      event('boar', 'dehydration', 'unweaned_without_parent'),
      event('hare', 'dehydration', 'unweaned_without_parent'),
      event('boar', 'natural', 'unweaned_without_parent')]) recordDeprivationBySpeciesCare(tally, death);
    expect(tally).toEqual({
      'boar/starvation/unweaned_without_parent': 1,
      'boar/dehydration/unweaned_with_parent': 1,
      'boar/dehydration/unweaned_without_parent': 1,
      'hare/dehydration/unweaned_without_parent': 1,
    });
  });

  it('retains courtship outcome and contact reason rather than treating every attempt as chance', () => {
    const tally: Record<string, number> = {};
    const event = (outcome: WorldEvent['outcome'], reason: string): WorldEvent => ({
      id: 'test', type: 'courtship', worldTime: 0, simVersion: 'test', patchId: 0,
      actors: ['dhole_female', 'dhole_male'], conditions: { species: 'dhole', reason },
      outcome, effects: {}, causalParents: [], confidence: 'authoritative',
    });
    for (const item of [event('interrupted', 'contact_lost'), event('interrupted', 'contact_lost'),
      event('failure', 'contact_trial'), event('success', 'contact_trial')]) {
      recordCourtshipByOutcomeReason(tally, item);
    }
    expect(tally).toEqual({ 'dhole/interrupted/contact_lost': 2,
      'dhole/failure/contact_trial': 1, 'dhole/success/contact_trial': 1 });
  });

  it('measures the requested island household and emits honest progress without advancing the world itself', () => {
    const progress: Array<{ completedDays: number; requestedDays: number; livingAnimals: number; failures: number }> = [];
    const result = runSoak({ seed: 1, days: 1, terrainProfile: 'island_v1', communityProfile: 'household_v1', speciesDir,
      onProgress: p => progress.push(p) });
    expect(progress).toEqual([{ completedDays: 1, requestedDays: 1,
      livingAnimals: Object.values(result.finalPopulation).reduce((n, count) => n + count, 0), failures: 0 }]);
    expect(result.community.profile).toBe('household_v1'); expect(result.community.alive + result.community.deaths).toBe(4);
    expect(result.community.births).toBe(0);
    expect(result.community.careEvents).toBe(0);
    expect(result.community.rebuilds).toBeLessThanOrEqual(result.community.collapses);
    expect(result.completedDays).toBe(1); expect(result.stoppedEarly).toBe(false);
    expect(result.nutrientDrift).toBeLessThan(.01);
    expect(() => runSoak({ seed: 1, days: 1, speciesDir, communityProfile: 'invalid' as 'none' })).toThrow(/community profile/);
  });

  it.each([NaN, Infinity, -1, 0, 0.5])('rejects an invalid duration %s instead of reporting a false pass', (days) => {
    expect(() => runSoak({ seed: 1, days, speciesDir })).toThrow('positive safe integer');
  });

  it('rejects an invalid seed before starting the world', () => {
    expect(() => runSoak({ seed: NaN, days: 1, speciesDir })).toThrow('seed must');
  });
});
