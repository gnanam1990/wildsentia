import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { patchCentre } from '@vana/shared';
import { createWorld } from '../src/world.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

// A swamp specialist stays in the swamp: dry forest held about twice the swamp's browse, so a
// sitatunga fed its way onto terra firme (docs/2026-10-15-congo-species-behaviour-audit.md).
describe('wetland species keep to the wetlands', () => {
  it.each(['sitatunga', 'water_chevrotain', 'dwarf_crocodile'])('%s spends its days in wet habitats beside richer dry forest', (id) => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { [id]: 1 }, minPopulation: {} });
    const swamp = world.patches.find((p) => p.habitat === 'swamp_forest'
      && p.neighbours.filter((n) => world.patches[n]!.habitat === 'terra_firme').length >= 2)!;
    const animal = world.agents[0]!, c = patchCentre(world.grid, swamp.id);
    Object.assign(animal, { patchId: swamp.id, position: { x: c.x, z: c.z, heading: 0 }, dependentOn: null, pregnantSince: null,
      offspringIds: [], drives: { hunger: 0.4, thirst: 0.1, fatigue: 0, fear: 0 } });
    let dry = 0;
    for (let h = 0; h < 72; h++) { world.step(1); if (world.patches[animal.patchId]!.habitat === 'terra_firme') dry++; }
    expect(dry).toBeLessThanOrEqual(6);
  }, 240_000);
});
