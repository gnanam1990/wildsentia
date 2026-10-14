import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS, WORLD_SECONDS_PER_DAY } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const CONGO_DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const options = { seed: 5, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1' as const, initialAgents: {}, minPopulation: {} };

// A server restarts, rolls back and runs its lab from its own checkpoints: a Congo checkpoint
// must restore whatever the season, and one saved before the Congo flowered must too.
describe('restoring a Congo checkpoint', () => {
  it('restores with a fish cohort in flooded forest at the start of the wet season', () => {
    const saved = takeSnapshot(createWorld(options));
    saved.worldTime = 180 * WORLD_SECONDS_PER_DAY - 3600;
    saved.microEcology!.updatedAt = saved.worldTime;
    const patch = saved.patches.find((p) => p.habitat === 'flooded_forest' && p.waterVolume >= 20)!;
    const micro = saved.microEcology!.patches[patch.id]!;
    patch.soilNutrients -= (0.1 - micro.fishBiomassKg) * NUTRIENT_PER_KG_BIOMASS;
    micro.fishBiomassKg = 0.1; micro.lastFishSpawnYear = 0;
    const world = restoreSnapshot(saved, options);
    world.step(1);
    expect(world.microEcology.patches[patch.id]!.fishCohort?.stage).toBe('eggs');
    expect(() => restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(world))), options)).not.toThrow();
  }, 120_000);

  it('restores one saved before the Congo forest flowered, giving its forest the flowering guild', () => {
    const saved = takeSnapshot(createWorld(options));
    for (const p of saved.patches) {
      const g = p.floweringGuild;
      if (!g) continue;
      p.capacity.browse += g.capacityKg; p.plant.browse += g.vegetativeKg;
      delete p.floweringGuild;
    }
    const world = restoreSnapshot(saved, options);
    expect(world.patches.some((p) => p.habitat === 'terra_firme' && p.floweringGuild)).toBe(true);
    // A guild missing from only some forest is damage, not an old checkpoint.
    const partial = takeSnapshot(world);
    delete partial.patches.find((p) => p.floweringGuild)!.floweringGuild;
    expect(() => restoreSnapshot(partial, options)).toThrow(/flowering guild/);
  }, 120_000);
});
