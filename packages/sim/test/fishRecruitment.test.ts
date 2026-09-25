import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS, WORLD_SECONDS_PER_DAY, microBiomassKg, microCounts } from '@vana/shared';
import { fileURLToPath } from 'node:url';
import { buildGrid } from '../src/grid.js';
import { emptyMicroEcology, stepMicroEcology } from '../src/fields/microEcology.js';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

function fixture() {
  const patches = buildGrid(42);
  for (const patch of patches) patch.waterVolume = 0;
  const patch = patches[210]!;
  patch.habitat = 'water'; patch.surface = 'land'; patch.waterVolume = 50_000;
  patch.plant = { grass: 0, browse: 0 }; patch.soilNutrients = 0;
  const state = emptyMicroEcology(patches, 0);
  const micro = state.patches[patch.id]!;
  micro.fishBiomassKg = 0.1;
  micro.aquaticProducerBiomassKg = 0.1;
  micro.lastFishSpawnYear = 0;
  const total = () => patches.reduce((sum, p) => sum + p.soilNutrients
    + (p.plant.grass + p.plant.browse) * NUTRIENT_PER_KG_BIOMASS, 0)
    + microBiomassKg(state) * NUTRIENT_PER_KG_BIOMASS;
  return { patches, patch, state, micro, total };
}

describe('finite freshwater fish early life', () => {
  it('emits a world-authoritative spawn event and resumes its egg state from a checkpoint', () => {
    const options = { seed: 8, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      initialAgents: {}, minPopulation: {} };
    const original = createWorld(options), saved = takeSnapshot(original);
    const spawnAt = 270 * WORLD_SECONDS_PER_DAY;
    saved.worldTime = spawnAt - 3600;
    saved.microEcology!.updatedAt = saved.worldTime;
    const patch = saved.patches.find(p => p.habitat === 'water' && p.waterVolume >= 20)!;
    const micro = saved.microEcology!.patches[patch.id]!;
    patch.soilNutrients -= (0.1 - micro.fishBiomassKg) * NUTRIENT_PER_KG_BIOMASS;
    micro.fishBiomassKg = 0.1;
    micro.lastFishSpawnYear = 0;
    const world = restoreSnapshot(saved, options), baseline = world.totalNutrients();
    world.step(1);
    const event = world.log.all().find(entry => entry.type === 'fish_spawned');
    expect(event?.worldTime).toBe(spawnAt);
    expect(event?.patchId).toBe(patch.id);
    expect(event?.actors).toEqual([]);
    expect(world.microEcology.patches[patch.id]!.fishCohort?.stage).toBe('eggs');
    expect(world.totalNutrients()).toBeCloseTo(baseline, 7);
    const restarted = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(world))), options);
    expect(restarted.microEcology.patches[patch.id]!.fishCohort)
      .toEqual(world.microEcology.patches[patch.id]!.fishCohort);
  });

  it('spawns once from established adult biomass, hatches, feeds from producer stock, and recruits after a separate larval stage', () => {
    const f = fixture(), baseline = f.total();
    const spawnAt = 270 * WORLD_SECONDS_PER_DAY;
    const first = stepMicroEcology(f.state, f.patches, [], 1, 'wet', spawnAt - 3600);
    expect(first.map(event => event.type)).toEqual(['fish_spawned']);
    const eggs = f.micro.fishCohort!.biomassKg;
    expect(f.micro.fishCohort!.stage).toBe('eggs');
    expect(f.micro.lastFishSpawnYear).toBe(1);
    expect(eggs).toBeGreaterThan(0);
    expect(f.micro.fishBiomassKg).toBeLessThan(0.1);
    expect(microCounts(f.micro).fish).toBe(Math.round(f.micro.fishBiomassKg * 10));
    expect(f.total()).toBeCloseTo(baseline, 8);

    let at = spawnAt;
    const events = [];
    for (let day = 0; day < 23; day++) {
      events.push(...stepMicroEcology(f.state, f.patches, [], 24, 'wet', at));
      at += WORLD_SECONDS_PER_DAY;
      expect(f.total()).toBeCloseTo(baseline, 7);
      if (day === 0) expect(f.micro.fishCohort!.stage).toBe('eggs');
      if (day === 1) expect(f.micro.fishCohort!.stage).toBe('larvae');
    }
    expect(events.filter(event => event.type === 'fish_hatched')).toHaveLength(1);
    expect(events.filter(event => event.type === 'fish_recruited')).toHaveLength(1);
    expect(events.filter(event => event.type === 'fish_spawned')).toHaveLength(0);
    expect(f.micro.fishCohort).toBeUndefined();
    expect(f.micro.fishBiomassKg).toBeGreaterThan(0);
  });

  it('recycles eggs on drying and cannot spawn in a disconnected empty or coastal pool', () => {
    const f = fixture(), baseline = f.total(), spawnAt = 270 * WORLD_SECONDS_PER_DAY;
    stepMicroEcology(f.state, f.patches, [], 1, 'wet', spawnAt - 3600);
    const cohortKg = f.micro.fishCohort!.biomassKg;
    f.patch.waterVolume = 0;
    const lost = stepMicroEcology(f.state, f.patches, [], 1, 'wet', spawnAt);
    expect(lost.map(event => event.type)).toEqual(['fish_cohort_lost']);
    expect(lost[0]!.recycledKg).toBeCloseTo(cohortKg, 10);
    expect(f.micro.fishCohort).toBeUndefined();
    expect(f.micro.fishBiomassKg).toBe(0);
    expect(f.total()).toBeCloseTo(baseline, 8);
    f.patch.waterVolume = 50_000;
    stepMicroEcology(f.state, f.patches, [], 1, 'wet', spawnAt + 3600);
    expect(f.micro.fishCohort).toBeUndefined();
    f.patch.surface = 'coast';
    f.micro.lastFishSpawnYear = 0;
    expect(stepMicroEcology(f.state, f.patches, [], 1, 'wet', spawnAt + 7200)
      .some(event => event.type === 'fish_spawned')).toBe(false);
  });

  it('continues identically from a cloned local cohort checkpoint', () => {
    const f = fixture(), spawnAt = 270 * WORLD_SECONDS_PER_DAY;
    stepMicroEcology(f.state, f.patches, [], 1, 'wet', spawnAt - 3600);
    const otherPatches = structuredClone(f.patches), otherState = structuredClone(f.state);
    for (let day = 0; day < 23; day++) {
      const at = spawnAt + day * WORLD_SECONDS_PER_DAY;
      expect(stepMicroEcology(f.state, f.patches, [], 24, 'wet', at))
        .toEqual(stepMicroEcology(otherState, otherPatches, [], 24, 'wet', at));
    }
    expect(f.state).toEqual(otherState);
    expect(f.patches).toEqual(otherPatches);
  });
});
