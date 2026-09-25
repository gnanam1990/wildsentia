import { describe, expect, it } from 'vitest';
import { buildGrid } from '../src/grid.js';
import { emptyMicroEcology, seedMicroEcology, stepMicroEcology } from '../src/fields/microEcology.js';
import { makeCarcass } from '../src/fields/decomposition.js';
import { microBiomassKg, microCounts } from '@vana/shared';
import { NUTRIENT_PER_KG_BIOMASS } from '@vana/shared';

describe('population-level micro ecology', () => {
  it('seeds role biomass from existing patch stocks and exposes counts without agents', () => {
    const patches = buildGrid(7), state = seedMicroEcology(patches, 0);
    expect(state.patches).toHaveLength(patches.length);
    expect(microBiomassKg(state)).toBeGreaterThan(0);
    const living = state.patches.find((p) => p.antBiomassKg > 0)!;
    expect(microCounts(living).ants).toBeGreaterThan(0);
    expect(patches.reduce((sum, p) => sum + p.soilNutrients, 0)).toBeLessThan(400 * 600);
  });

  it('seeds fish and finite aquatic producer biomass only in wet inland freshwater habitat', () => {
    const patches = buildGrid(7);
    const land = patches[210]!, coast = patches[211]!, freshwater = patches[212]!;
    land.habitat = 'grassland'; land.surface = 'land'; land.waterVolume = 600;
    coast.habitat = 'water'; coast.surface = 'coast'; coast.waterVolume = 50_000;
    freshwater.habitat = 'water'; freshwater.surface = 'land'; freshwater.waterVolume = 50_000;
    const state = seedMicroEcology(patches, 0);
    expect(state.patches[land.id]!.fishBiomassKg).toBe(0);
    expect(state.patches[land.id]!.aquaticProducerBiomassKg).toBe(0);
    expect(state.patches[coast.id]!.fishBiomassKg).toBe(0);
    expect(state.patches[coast.id]!.aquaticProducerBiomassKg).toBe(0);
    expect(state.patches[freshwater.id]!.fishBiomassKg).toBeGreaterThan(0);
    expect(state.patches[freshwater.id]!.aquaticProducerBiomassKg).toBeGreaterThan(0);
  });

  it('moves carcass biomass into detritivores/decomposers while conserving mass', () => {
    const patches = buildGrid(3), patch = patches.find((p) => p.habitat !== 'water')!;
    const carcass = makeCarcass('c1', 'a1', 'sambar', patch.id, 0, 'natural', 'high', 100);
    const state = emptyMicroEcology(patches, 0);
    const stocks = () => patches.reduce((sum, p) => sum + p.soilNutrients
      + (p.plant.grass + p.plant.browse) * NUTRIENT_PER_KG_BIOMASS, 0);
    const before = stocks()
      + (Object.values(carcass.biomass).reduce((sum, n) => sum + (n ?? 0), 0) + microBiomassKg(state)) * NUTRIENT_PER_KG_BIOMASS;
    stepMicroEcology(state, patches, [carcass], 24, 'wet', 0);
    const after = stocks()
      + (Object.values(carcass.biomass).reduce((sum, n) => sum + (n ?? 0), 0) + microBiomassKg(state)) * NUTRIENT_PER_KG_BIOMASS;
    expect(after).toBeCloseTo(before, 7);
    expect(microBiomassKg(state)).toBeGreaterThan(0);
  });

  it('keeps nutrient units conserved across a standalone population step', () => {
    const patches = buildGrid(4), state = seedMicroEcology(patches, 0);
    const before = patches.reduce((sum, p) => sum + p.soilNutrients
      + (p.plant.grass + p.plant.browse) * NUTRIENT_PER_KG_BIOMASS, 0)
      + microBiomassKg(state) * NUTRIENT_PER_KG_BIOMASS;
    stepMicroEcology(state, patches, [], 12, 'monsoon', 0);
    const after = patches.reduce((sum, p) => sum + p.soilNutrients
      + (p.plant.grass + p.plant.browse) * NUTRIENT_PER_KG_BIOMASS, 0)
      + microBiomassKg(state) * NUTRIENT_PER_KG_BIOMASS;
    expect(after).toBeCloseTo(before, 8);
  });

  it('moves finite shoreline insect biomass into fish and makes prey availability affect growth', () => {
    const patches = buildGrid(12);
    const water = patches[210]!, shore = patches[209]!;
    water.habitat = 'water'; water.waterVolume = 50_000; water.plant = { grass: 0, browse: 0 };
    water.soilNutrients = 0; // Isolate food coming from the shore rather than local detritivores.
    for (const id of water.neighbours) if (id !== shore.id) patches[id]!.habitat = 'water';
    shore.habitat = 'riparian'; shore.surface = 'land';
    const state = emptyMicroEcology(patches, 0);
    state.patches[water.id]!.fishBiomassKg = 0.02;
    state.patches[shore.id]!.antBiomassKg = 0.4;
    const noPreyPatches = structuredClone(patches), noPreyState = structuredClone(state);
    noPreyState.patches[shore.id]!.antBiomassKg = 0;
    const total = (ps: typeof patches, ms: typeof state) => ps.reduce((sum, p) => sum + p.soilNutrients
      + (p.plant.grass + p.plant.browse) * NUTRIENT_PER_KG_BIOMASS, 0)
      + microBiomassKg(ms) * NUTRIENT_PER_KG_BIOMASS;
    const before = total(patches, state);
    stepMicroEcology(state, patches, [], 24, 'wet', 0);
    stepMicroEcology(noPreyState, noPreyPatches, [], 24, 'wet', 0);
    expect(state.patches[shore.id]!.antBiomassKg).toBeLessThan(0.4 * (1 - 0.004 * 24));
    expect(state.patches[water.id]!.fishBiomassKg).toBeGreaterThan(noPreyState.patches[water.id]!.fishBiomassKg);
    expect(total(patches, state)).toBeCloseTo(before, 7);
  });

  it('feeds established fish from finite local aquatic producers, never directly from soil', () => {
    const patches = buildGrid(16), water = patches[210]!;
    for (const patch of patches) patch.waterVolume = 0;
    water.habitat = 'water'; water.surface = 'land'; water.waterVolume = 50_000;
    water.plant = { grass: 0, browse: 0 }; water.soilNutrients = 0;
    for (const id of water.neighbours) patches[id]!.surface = 'ocean';
    const state = emptyMicroEcology(patches, 0);
    const school = state.patches[water.id]!;
    school.fishBiomassKg = 0.02;
    school.aquaticProducerBiomassKg = 0.05;
    const withoutPatches = structuredClone(patches), withoutState = structuredClone(state);
    withoutState.patches[water.id]!.aquaticProducerBiomassKg = 0;
    const total = (ps: typeof patches, ms: typeof state) => ps.reduce((sum, p) => sum + p.soilNutrients
      + (p.plant.grass + p.plant.browse) * NUTRIENT_PER_KG_BIOMASS, 0)
      + microBiomassKg(ms) * NUTRIENT_PER_KG_BIOMASS;
    const before = total(patches, state);
    stepMicroEcology(state, patches, [], 24, 'wet', 0);
    stepMicroEcology(withoutState, withoutPatches, [], 24, 'wet', 0);
    expect(school.aquaticProducerBiomassKg).toBeLessThan(0.05 * (1 - 0.004 * 24));
    expect(school.fishBiomassKg).toBeGreaterThan(withoutState.patches[water.id]!.fishBiomassKg);
    expect(withoutState.patches[water.id]!.fishBiomassKg).toBeLessThan(0.02);
    expect(total(patches, state)).toBeCloseTo(before, 8);
  });

  it('recycles a dried producer pool and resumes only with locally debited nutrients after rewetting', () => {
    const patches = buildGrid(17), pool = patches[210]!;
    for (const patch of patches) patch.waterVolume = 0;
    pool.habitat = 'water'; pool.surface = 'land'; pool.soilNutrients = 0;
    pool.plant = { grass: 0, browse: 0 };
    const state = emptyMicroEcology(patches, 0), micro = state.patches[pool.id]!;
    micro.aquaticProducerBiomassKg = 0.05;
    stepMicroEcology(state, patches, [], 24, 'wet', 0);
    expect(micro.aquaticProducerBiomassKg).toBe(0);
    const recycledNutrients = pool.soilNutrients + micro.decomposerBiomassKg * NUTRIENT_PER_KG_BIOMASS;
    expect(recycledNutrients).toBeCloseTo(0.05 * NUTRIENT_PER_KG_BIOMASS, 12);
    pool.waterVolume = 50_000;
    stepMicroEcology(state, patches, [], 24, 'wet', 86_400);
    expect(micro.aquaticProducerBiomassKg).toBeGreaterThan(0);
    expect(micro.fishBiomassKg).toBe(0);
    expect(pool.soilNutrients + (micro.decomposerBiomassKg + micro.aquaticProducerBiomassKg)
      * NUTRIENT_PER_KG_BIOMASS).toBeCloseTo(0.05 * NUTRIENT_PER_KG_BIOMASS, 12);
  });

  it('replays identical aquatic producer and fish transfers from a cloned checkpoint', () => {
    const patches = buildGrid(18), water = patches[210]!;
    water.habitat = 'water'; water.surface = 'land'; water.waterVolume = 50_000;
    const state = seedMicroEcology(patches, 0);
    const secondPatches = structuredClone(patches), secondState = structuredClone(state);
    for (let day = 0; day < 4; day++) {
      stepMicroEcology(state, patches, [], 24, 'wet', day * 86_400);
      stepMicroEcology(secondState, secondPatches, [], 24, 'wet', day * 86_400);
    }
    expect(state).toEqual(secondState);
    expect(patches).toEqual(secondPatches);
  });

  it('does not grow fish from dry beds, even with soil nutrients present', () => {
    const patches = buildGrid(6), patch = patches[210]!;
    patch.habitat = 'riparian'; patch.waterVolume = 0;
    const state = emptyMicroEcology(patches, 0);
    stepMicroEcology(state, patches, [], 24, 'wet', 0);
    expect(state.patches[patch.id]!.fishBiomassKg).toBe(0);
  });

  it('recolonizes only along wet freshwater edges, one edge per step, without making biomass', () => {
    const patches = buildGrid(6), state = emptyMicroEcology(patches, 0);
    const source = patches[210]!, bridge = patches[211]!, far = patches[212]!;
    for (const p of patches) p.waterVolume = 0;
    for (const p of [source, bridge, far]) {
      p.habitat = 'water'; p.surface = 'land'; p.waterVolume = 50_000;
      p.plant = { grass: 0, browse: 0 }; p.soilNutrients = 0;
    }
    state.patches[source.id]!.fishBiomassKg = 0.024;
    const total = () => patches.reduce((sum, p) => sum + p.soilNutrients
      + (p.plant.grass + p.plant.browse) * NUTRIENT_PER_KG_BIOMASS, 0)
      + microBiomassKg(state) * NUTRIENT_PER_KG_BIOMASS;
    const before = total();
    stepMicroEcology(state, patches, [], 24, 'wet', 0);
    expect(state.patches[bridge.id]!.fishBiomassKg).toBeGreaterThan(0);
    expect(state.patches[far.id]!.fishBiomassKg).toBe(0);
    expect(state.patches[source.id]!.fishBiomassKg).toBeGreaterThan(0.002);
    expect(total()).toBeCloseTo(before, 8);
    stepMicroEcology(state, patches, [], 24, 'wet', 86_400);
    expect(state.patches[far.id]!.fishBiomassKg).toBeGreaterThan(0);
    expect(total()).toBeCloseTo(before, 8);
  });

  it('leaves isolated wet pools empty across dry, coast, and ocean barriers', () => {
    for (const barrierSurface of ['land', 'coast', 'ocean'] as const) {
      const patches = buildGrid(6), state = emptyMicroEcology(patches, 0);
      for (const p of patches) p.waterVolume = 0;
      const source = patches[210]!, barrier = patches[211]!, isolated = patches[212]!;
      for (const p of [source, barrier, isolated]) {
        p.habitat = 'water'; p.waterVolume = 50_000; p.plant = { grass: 0, browse: 0 };
      }
      source.surface = 'land'; isolated.surface = 'land';
      barrier.surface = barrierSurface;
      if (barrierSurface === 'land') barrier.waterVolume = 0;
      state.patches[source.id]!.fishBiomassKg = 0.024;
      stepMicroEcology(state, patches, [], 24, 'wet', 0);
      expect(state.patches[barrier.id]!.fishBiomassKg, `${barrierSurface} barrier`).toBe(0);
      expect(state.patches[isolated.id]!.fishBiomassKg, `${barrierSurface} barrier`).toBe(0);
    }
  });

  it('resolves two schools entering one pool identically regardless of patch storage order', () => {
    const patches = buildGrid(6), state = emptyMicroEcology(patches, 0);
    for (const p of patches) p.waterVolume = 0;
    for (const id of [209, 210, 211]) {
      const p = patches[id]!;
      p.habitat = 'water'; p.surface = 'land'; p.waterVolume = 50_000;
      p.plant = { grass: 0, browse: 0 }; p.soilNutrients = 0;
    }
    state.patches[209]!.fishBiomassKg = 0.024;
    state.patches[211]!.fishBiomassKg = 0.024;
    const reversedPatches = structuredClone(patches).reverse();
    const reversedState = structuredClone(state);
    reversedState.patches.reverse();
    stepMicroEcology(state, patches, [], 24, 'wet', 0);
    stepMicroEcology(reversedState, reversedPatches, [], 24, 'wet', 0);
    for (const id of [209, 210, 211]) {
      expect(state.patches[id]!.fishBiomassKg).toBeCloseTo(
        reversedState.patches.find((m) => m.patchId === id)!.fishBiomassKg, 12);
    }
    expect(state.patches[210]!.fishBiomassKg).toBeGreaterThan(0);
  });

  it('does not produce fish in an otherwise suitable but never-colonized wet pool', () => {
    const patches = buildGrid(6), patch = patches[210]!;
    patch.habitat = 'water'; patch.surface = 'land'; patch.waterVolume = 50_000;
    const state = emptyMicroEcology(patches, 0);
    stepMicroEcology(state, patches, [], 24, 'wet', 0);
    expect(state.patches[patch.id]!.fishBiomassKg).toBe(0);
  });

  it('recycles fish from a dried pool and requires connected recolonization after rewetting', () => {
    const patches = buildGrid(6), dryPool = patches[210]!;
    for (const p of patches) p.waterVolume = 0;
    dryPool.habitat = 'water'; dryPool.surface = 'land'; dryPool.soilNutrients = 0;
    dryPool.plant = { grass: 0, browse: 0 };
    const state = emptyMicroEcology(patches, 0);
    state.patches[dryPool.id]!.fishBiomassKg = 0.024;
    stepMicroEcology(state, patches, [], 24, 'wet', 0);
    expect(state.patches[dryPool.id]!.fishBiomassKg).toBe(0);
    expect(dryPool.soilNutrients + state.patches[dryPool.id]!.decomposerBiomassKg * NUTRIENT_PER_KG_BIOMASS)
      .toBeCloseTo(0.024 * NUTRIENT_PER_KG_BIOMASS, 12);
    dryPool.waterVolume = 50_000;
    stepMicroEcology(state, patches, [], 24, 'wet', 86_400);
    expect(state.patches[dryPool.id]!.fishBiomassKg).toBe(0);
  });

  it('shares one shoreline harvest budget across neighbouring fish schools', () => {
    const patches = buildGrid(8), state = emptyMicroEcology(patches, 0);
    const source = patches[190]!, fishIds = [191, 210];
    source.habitat = 'riparian'; source.surface = 'land'; source.plant = { grass: 0, browse: 0 };
    state.patches[source.id]!.antBiomassKg = 0.03;
    for (const id of fishIds) {
      const p = patches[id]!;
      p.habitat = 'water'; p.waterVolume = 50_000; p.plant = { grass: 0, browse: 0 }; p.soilNutrients = 0;
      state.patches[id]!.fishBiomassKg = 0.02;
      for (const neighbour of p.neighbours) if (neighbour !== source.id) patches[neighbour]!.habitat = 'water';
    }
    stepMicroEcology(state, patches, [], 24, 'wet', 0);
    const afterDecay = 0.03 * (1 - 0.004 * 24);
    expect(state.patches[source.id]!.antBiomassKg).toBeCloseTo(afterDecay * 0.85, 10);
    expect(state.patches[fishIds[0]!]!.fishBiomassKg).toBeGreaterThan(state.patches[fishIds[1]!]!.fishBiomassKg);
  });
});
