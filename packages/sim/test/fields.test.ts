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

  it('keeps a lake through the whole dry season: springs feed it when the rain stops', () => {
    // Every pool in the forest used to dry to a few hundred litres by the dry season's end,
    // lakes included, and the elephants and gaur died of thirst each year. Perennial water is
    // what a dry-season forest is organised around.
    const lake = buildGrid(2).find((p) => p.habitat === 'water')!;
    for (let h = 0; h < 90 * 24; h++) updateWater(lake, 1, 'dry');
    expect(lake.waterVolume).toBeGreaterThan(40_000);
  });

  it('keeps some water in a marsh through the dry season, but less than in a lake', () => {
    const patches = buildGrid(2);
    const marsh = patches.find((p) => p.habitat === 'marsh')!;
    const lake = patches.find((p) => p.habitat === 'water')!;
    for (let h = 0; h < 90 * 24; h++) { updateWater(marsh, 1, 'dry'); updateWater(lake, 1, 'dry'); }
    expect(marsh.waterVolume).toBeGreaterThan(2_000);
    expect(marsh.waterVolume).toBeLessThan(lake.waterVolume);
  });

  it('lets rain-fed ground dry out in the dry season', () => {
    const grass = buildGrid(2).find((p) => p.habitat === 'grassland')!;
    grass.waterVolume = 1_200;
    for (let h = 0; h < 90 * 24; h++) updateWater(grass, 1, 'dry');
    expect(grass.waterVolume).toBeLessThan(600);
  });

  it('wets the soil through the monsoon and dries it through the dry season', () => {
    // Drying used to subtract the evaporation *fraction* as an absolute amount, far more than
    // rain could put back, so every patch's soil was bone dry by the first monsoon's end and
    // stayed that way. Plants grew at forty percent of their rate all year, and the grazers ate
    // the forest down a little further every year until they starved.
    const grass = buildGrid(2).find((p) => p.habitat === 'grassland')!;
    grass.soilMoisture = 0.3;
    for (let h = 0; h < 45 * 24; h++) updateWater(grass, 1, 'monsoon');
    expect(grass.soilMoisture).toBeGreaterThan(0.8);
    for (let h = 0; h < 90 * 24; h++) updateWater(grass, 1, 'dry');
    expect(grass.soilMoisture).toBeLessThan(0.15);
  });

  it('keeps a marsh damper than open grassland through the dry season', () => {
    const patches = buildGrid(2);
    const marsh = patches.find((p) => p.habitat === 'marsh')!;
    const grass = patches.find((p) => p.habitat === 'grassland')!;
    for (let h = 0; h < 90 * 24; h++) { updateWater(marsh, 1, 'dry'); updateWater(grass, 1, 'dry'); }
    expect(marsh.soilMoisture).toBeGreaterThan(grass.soilMoisture + 0.1);
  });

  it('refills during the monsoon', () => {
    const patch = buildGrid(2).find((p) => p.habitat === 'riparian')!;
    patch.waterVolume = 0;
    for (let h = 0; h < 200; h++) updateWater(patch, 1, 'monsoon');
    expect(patch.waterVolume).toBeGreaterThan(0);
  });
});
