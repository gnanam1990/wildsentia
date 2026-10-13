import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { WORLD_SECONDS_PER_DAY, terrainCostFor } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { loadSpeciesDir } from '../src/config/loader.js';
import { SPECIES_DIR } from './helpers.js';

const CONGO_DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const CONGO = loadSpeciesDir(CONGO_DIR);

describe('the flood (1B)', () => {
  it('costs a leopard more to cross flooded forest, and the chevrotain less', () => {
    const leopard = CONGO.get('african_leopard')!, chevrotain = CONGO.get('water_chevrotain')!, duiker = CONGO.get('blue_duiker')!;
    expect(terrainCostFor(leopard, 'flooded_forest', true)).toBeGreaterThan(terrainCostFor(leopard, 'flooded_forest', false));
    expect(terrainCostFor(duiker, 'flooded_forest', true)).toBe(4);
    expect(terrainCostFor(chevrotain, 'flooded_forest', true)).toBeLessThanOrEqual(terrainCostFor(chevrotain, 'flooded_forest', false));
    expect(terrainCostFor(leopard, 'terra_firme', true)).toBe(terrainCostFor(leopard, 'terra_firme', false));
  });

  it('floods the Congo flooded forest in the rains and drains it in the drier spells; the island never floods', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1', initialAgents: { blue_duiker: 5 }, minPopulation: {} });
    const flooded = () => world.patches.filter((p) => p.habitat === 'flooded_forest' && p.flooded).length;
    const forest = world.patches.filter((p) => p.habitat === 'flooded_forest').length;
    world.step(1);
    expect(flooded()).toBe(forest); // long rains
    world.step(91 * 24 - 1); // into the first drier spell
    expect(world.now()).toBeGreaterThanOrEqual(90 * WORLD_SECONDS_PER_DAY);
    expect(flooded()).toBe(0);
    const island = createWorld({ seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2', initialAgents: { chital: 5 }, minPopulation: {} });
    island.step(2);
    expect(island.patches.some((p) => p.flooded !== undefined)).toBe(false);
  }, 300_000);
});
