import { describe, expect, it } from 'vitest';
import { buildGrid } from '../src/grid.js';
import { growPlants } from '../src/fields/plants.js';
import { updateWater } from '../src/fields/water.js';

describe('plant growth', () => {
  it('grows toward capacity but never past it', () => {
    const patch = buildGrid(1).find((p) => p.habitat === 'grassland')!;
    patch.plant.grass = patch.capacity.grass * 0.5;
    patch.soilNutrients = 1e9;
    for (let h = 0; h < 5000; h++) growPlants(patch, 1, 'monsoon');
    expect(patch.plant.grass).toBeGreaterThan(patch.capacity.grass * 0.9);
    expect(patch.plant.grass).toBeLessThanOrEqual(patch.capacity.grass + 1e-6);
  });

  it('does not grow from zero capacity', () => {
    const patch = buildGrid(1).find((p) => p.habitat === 'water')!;
    growPlants(patch, 100, 'monsoon');
    expect(patch.plant.grass).toBe(0);
  });

  it('draws the nutrients it reports', () => {
    const patch = buildGrid(1).find((p) => p.habitat === 'grassland')!;
    patch.plant.grass = 1000;
    const before = patch.soilNutrients;
    const { grew, nutrientsDrawn } = growPlants(patch, 10, 'monsoon');
    expect(grew).toBeGreaterThan(0);
    expect(before - patch.soilNutrients).toBeCloseTo(nutrientsDrawn, 9);
  });

  it('grows faster in monsoon than in the dry season', () => {
    const wet = buildGrid(1).find((p) => p.habitat === 'grassland')!;
    const dry = structuredClone(wet);
    wet.plant.grass = dry.plant.grass = 1000;
    growPlants(wet, 24, 'monsoon');
    growPlants(dry, 24, 'dry');
    expect(wet.plant.grass).toBeGreaterThan(dry.plant.grass);
  });

  it('stops growing when the soil is exhausted', () => {
    const patch = buildGrid(1).find((p) => p.habitat === 'grassland')!;
    patch.plant.grass = 100;
    patch.soilNutrients = 0;
    expect(growPlants(patch, 24, 'monsoon').grew).toBe(0);
  });
});

describe('water', () => {
  it('keeps volume non-negative through a dry season', () => {
    const patch = buildGrid(2).find((p) => p.habitat === 'riparian')!;
    for (let h = 0; h < 2000; h++) updateWater(patch, 1, 'dry');
    expect(patch.waterVolume).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(patch.waterVolume)).toBe(true);
  });

  it('refills during the monsoon', () => {
    const patch = buildGrid(2).find((p) => p.habitat === 'riparian')!;
    patch.waterVolume = 0;
    for (let h = 0; h < 200; h++) updateWater(patch, 1, 'monsoon');
    expect(patch.waterVolume).toBeGreaterThan(0);
  });
});
