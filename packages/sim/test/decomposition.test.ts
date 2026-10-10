import { describe, expect, it } from 'vitest';
import { CARCASS_FRACTIONS, NUTRIENT_PER_KG_BIOMASS, carcassMass, type Carcass } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { decayCarcass, makeCarcass } from '../src/fields/decomposition.js';

const grid = () => buildGrid(3);

const fresh = (massKg = 200, patchId = 5): Carcass =>
  makeCarcass('c1', 'sambar_0001', 'sambar', patchId, 0, 'predation', 'authoritative', massKg);

describe('makeCarcass', () => {
  it('splits the animal mass into tissue fractions that sum to its mass', () => {
    const carcass = fresh(200);
    expect(carcassMass(carcass.biomass)).toBeCloseTo(200, 9);
    expect(carcass.biomass.muscle).toBeCloseTo(200 * CARCASS_FRACTIONS.muscle, 9);
  });

  it('starts fresh, at stage one, with a scent radius', () => {
    const carcass = fresh();
    expect(carcass.decayStage).toBe(1);
    expect(carcass.scentRadiusM).toBeGreaterThan(0);
  });

  it('records the cause and how sure the simulation is of it', () => {
    const carcass = fresh();
    expect(carcass.cause).toBe('predation');
    expect(carcass.causeConfidence).toBe('authoritative');
  });
});

describe('decayCarcass', () => {
  it('moves every gram it removes into the patch soil', () => {
    const patches = grid();
    const carcass = fresh(200, patches[5]!.id);
    const before = carcassMass(carcass.biomass) * NUTRIENT_PER_KG_BIOMASS + patches[5]!.soilNutrients;
    decayCarcass(carcass, patches[5]!, 24, 'monsoon');
    const after = carcassMass(carcass.biomass) * NUTRIENT_PER_KG_BIOMASS + patches[5]!.soilNutrients;
    expect(after).toBeCloseTo(before, 9);
  });

  it('decays faster in the monsoon than in the dry season', () => {
    const patches = grid();
    const wet = fresh(200, patches[5]!.id);
    const dry = fresh(200, patches[5]!.id);
    decayCarcass(wet, patches[5]!, 48, 'monsoon');
    decayCarcass(dry, structuredClone(patches[5]!), 48, 'dry');
    expect(carcassMass(wet.biomass)).toBeLessThan(carcassMass(dry.biomass));
  });

  it('advances through every stage and reaches stage five', () => {
    const patches = grid();
    const carcass = fresh(200, patches[5]!.id);
    const seen = new Set<number>([carcass.decayStage]);
    for (let h = 0; h < 24 * 120; h++) {
      decayCarcass(carcass, patches[5]!, 1, 'monsoon');
      seen.add(carcass.decayStage);
      if (carcass.decayStage === 5 && carcassMass(carcass.biomass) < 0.01) break;
    }
    expect(carcass.decayStage).toBe(5);
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never drives any tissue negative', () => {
    const patches = grid();
    const carcass = fresh(200, patches[5]!.id);
    for (let h = 0; h < 24 * 200; h++) {
      decayCarcass(carcass, patches[5]!, 1, 'monsoon');
      for (const value of Object.values(carcass.biomass)) expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('consumes soft tissue before bone', () => {
    const patches = grid();
    const carcass = fresh(200, patches[5]!.id);
    for (let h = 0; h < 24 * 20; h++) decayCarcass(carcass, patches[5]!, 1, 'monsoon');
    expect(carcass.biomass.muscle).toBeLessThan(carcass.biomass.bone);
  });

  it('reports the stage change so an event can be emitted for it', () => {
    const patches = grid();
    const carcass = fresh(200, patches[5]!.id);
    let changes = 0;
    for (let h = 0; h < 24 * 120; h++) {
      if (decayCarcass(carcass, patches[5]!, 1, 'monsoon').stageChanged) changes++;
    }
    expect(changes).toBe(4);
  });
});

describe('carcass pathogen load', () => {
  it('grows as the carcass ages, faster in warm, wet weather, and never past one', () => {
    const patches = grid(), patch = patches[5]!;
    patch.soilMoisture = 0.6;
    const monsoon = fresh(200, patch.id), dry = fresh(200, patch.id);
    expect(monsoon.pathogenLoad).toBeCloseTo(0.1, 9);
    for (let h = 0; h < 48; h++) { decayCarcass(monsoon, patch, 1, 'monsoon'); decayCarcass(dry, patch, 1, 'dry'); }
    expect(dry.pathogenLoad).toBeGreaterThan(0.1);
    expect(monsoon.pathogenLoad).toBeGreaterThan(dry.pathogenLoad);
    // A two-day-old monsoon kill is still within a tiger's tolerance (0.6), a jackal's (0.45) not for long.
    expect(monsoon.pathogenLoad).toBeLessThan(0.6);
    for (let h = 0; h < 24 * 30; h++) decayCarcass(monsoon, patch, 1, 'monsoon');
    expect(monsoon.pathogenLoad).toBeGreaterThan(0.98);
    expect(monsoon.pathogenLoad).toBeLessThanOrEqual(1);
  });
});
