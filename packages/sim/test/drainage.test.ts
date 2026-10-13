import { describe, expect, it } from 'vitest';
import type { Patch } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { drainageGraph, newWaterBudget, updateDrainage, waterBudgetResidual } from '../src/fields/drainage.js';
import { updateWater } from '../src/fields/water.js';
import { createWorld, SIM_VERSION } from '../src/world.js';
import { takeSnapshot, restoreSnapshot, upgradeV13Snapshot } from '../src/snapshot.js';
import { SPECIES_DIR } from './helpers.js';
import { asLegacySnapshot } from './legacySnapshot.js';
import { ISLAND_GRID } from '@vana/shared';

function catchment(ids = [42, 43, 44]): Patch[] {
  const grid = buildGrid(1);
  return ids.map((id, index) => ({ ...structuredClone(grid[id]!), elevation: (ids.length - index) / 10,
    habitat: 'grassland' as const, waterVolume: 3000 }));
}
describe('conserved downhill surface drainage', () => {
  it('routes real overflow through a chain and retains it in an interior basin', () => {
    const patches = catchment(), budget = newWaterBudget(patches, 0);
    updateDrainage(ISLAND_GRID, patches, 1, 'dry', budget);
    expect(patches.map(p => p.waterVolume)).toEqual([1200, 1200, 6565.5]);
    expect(patches[0]!.drainage).toMatchObject({ downstreamPatchId: 43, inflowL: 0, outflowL: 1788.5 });
    expect(patches[1]!.drainage!.inflowL).toBe(1788.5);
    expect(patches[2]!.drainage).toMatchObject({ downstreamPatchId: null, boundaryOutlet: false, outflowL: 0 });
    expect(budget.boundaryOutflowL).toBe(0);
    expect(waterBudgetResidual(patches, budget)).toBeCloseTo(0, 9);
  });
  it('exports only at a real boundary outlet and reconciles rain, seepage and evaporation', () => {
    const patches = catchment([2, 1, 0]), budget = newWaterBudget(patches, 0);
    patches[0]!.habitat = 'water';
    updateDrainage(ISLAND_GRID, patches, 24, 'monsoon', budget);
    expect(budget.groundwaterL).toBe(400 * 24);
    expect(budget.rainfallL).toBe(90 * 24 * 3);
    expect(budget.boundaryOutflowL).toBeGreaterThan(0);
    expect(patches[2]!.drainage!.boundaryOutlet).toBe(true);
    expect(waterBudgetResidual(patches, budget)).toBeCloseTo(0, 8);
  });
  it('has no uphill or diagonal edges, resolves ties by ID and leaves flat sinks intact', () => {
    const grid = buildGrid(1), p = grid[42]!;
    p.elevation = 0.5; p.neighbours = [63, 62, 43, 41];
    for (const id of p.neighbours) grid[id]!.elevation = 0.4;
    expect(drainageGraph(ISLAND_GRID, grid).get(42)).toBe(41);
    for (const id of p.neighbours) grid[id]!.elevation = 0.5;
    grid[63]!.elevation = 0;
    expect(drainageGraph(ISLAND_GRID, grid).get(42)).toBeNull();
  });
  it('is independent of patch and neighbour storage order', () => {
    const a = catchment(), b = structuredClone(a).reverse();
    for (const p of b) p.neighbours.reverse();
    const ba = newWaterBudget(a, 0), bb = newWaterBudget(b, 0);
    updateDrainage(ISLAND_GRID, a, 1, 'dry', ba); updateDrainage(ISLAND_GRID, b, 1, 'dry', bb);
    expect(b.reverse().map(p => [p.waterVolume, p.drainage])).toEqual(a.map(p => [p.waterVolume, p.drainage]));
    expect(bb).toEqual(ba);
  });
  it.each([0, -1, Infinity, NaN])('rejects invalid duration %s before mutation', hours => {
    const p = catchment(), before = structuredClone(p), budget = newWaterBudget(p, 0);
    expect(() => updateDrainage(ISLAND_GRID, p, hours, 'dry', budget)).toThrow(); expect(p).toEqual(before);
  });
  it('bounds evaporation by available water for a very long local step without erasing rain', () => {
    const p = catchment()[0]!, original = p.waterVolume;
    const flux = updateWater(p, 10000, 'dry');
    expect(flux.evaporatedL).toBe(original);
    expect(p.waterVolume).toBe(flux.rainfallL + flux.groundwaterL);
  });
  it('rejects nonfinite or negative water before changing any patch', () => {
    for (const volume of [-1, NaN, Infinity]) {
      const p = catchment(), budget = newWaterBudget(p, 0); p[1]!.waterVolume = volume;
      const before = structuredClone(p);
      expect(() => updateDrainage(ISLAND_GRID, p, 1, 'dry', budget)).toThrow(); expect(p).toEqual(before);
    }
  });
  it('accounts actual drinking and resumes the same water budget and events after snapshot restore', () => {
    const options = { seed: 1, speciesDir: SPECIES_DIR, initialAgents: { elephant: 2, chital: 10 }, minPopulation: {} };
    const world = createWorld(options);
    for (let i = 0; i < 24; i++) world.step(1);
    const drinks = world.log.all().filter(e => e.type === 'drank').reduce((sum, e) => sum + Number(e.effects.litres), 0);
    expect(drinks).toBeGreaterThan(0); expect(world.waterBudget.animalConsumptionL).toBeCloseTo(drinks, 8);
    expect(waterBudgetResidual(world.patches, world.waterBudget)).toBeCloseTo(0, 6);
    const snapshot = takeSnapshot(world), restored = restoreSnapshot(snapshot, options);
    expect(restored.waterBudget).toEqual(world.waterBudget);
    world.log.take(); restored.log.take();
    for (let i = 0; i < 48; i++) { world.step(1); restored.step(1); }
    expect(restored.log.take()).toEqual(world.log.take());
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(world));
    expect(waterBudgetResidual(restored.patches, restored.waterBudget)).toBeCloseTo(0, 6);
  });
  it('starts legacy accounting at the explicit upgrade checkpoint without inventing past flux', () => {
    const w = createWorld({ seed: 1, speciesDir: SPECIES_DIR, initialAgents: {}, minPopulation: {} });
    const old = asLegacySnapshot(takeSnapshot(w), 'sim_0.13.0');
    old.worldTime = 7200; delete old.waterBudget;
    const original = structuredClone(old), upgraded = upgradeV13Snapshot(old);
    expect(upgraded.simVersion).toBe(SIM_VERSION); expect(old).toEqual(original);
    expect(upgraded.waterBudget).toEqual(newWaterBudget(old.patches, 7200));
    expect(upgraded.patches.some(p => p.floweringGuild)).toBe(true);
    expect(() => upgradeV13Snapshot(upgraded)).toThrow('only sim_0.13.0');
  });
});
