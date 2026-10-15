import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONGO_GRID, ISLAND_GRID, patchCentre, treeAnchorForPatch, treeAnchorGeometry } from '@vana/shared';
import { createWorld } from '../src/world.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

// The Congo's climbable tree is a 24 m canopy tree, not the island's 6 m one: a mangabey roosts
// up in its limbs, a cat escapes only part way up (monkey tree la thane irukum, the owner).
describe('how high each climber goes', () => {
  it('makes the Congo tree a canopy tree and keeps the island\'s', () => {
    expect(treeAnchorGeometry(CONGO_GRID, 12_880)!.climbHeightM).toBe(22);
    expect(treeAnchorGeometry(ISLAND_GRID, 210)!.climbHeightM).toBe(6);
  });

  it.each([['agile_mangabey', 20], ['african_leopard', 8], ['african_golden_cat', 6]] as const)('takes a %s %s m up', (id, height) => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { [id]: 1 }, minPopulation: {}, retainEvents: 'all' });
    const patch = world.patches.find((p) => p.habitat === 'terra_firme' && treeAnchorForPatch(world.grid, p))!;
    const anchor = treeAnchorForPatch(world.grid, patch)!, c = patchCentre(world.grid, patch.id), animal = world.agents[0]!;
    Object.assign(animal, { patchId: patch.id, position: { x: anchor.x, z: anchor.z, heading: 0 }, dependentOn: null, pregnantSince: null,
      offspringIds: [], drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
    expect(world.species.get(id)!.locomotion.climbHeightM).toBe(height);
    void c;
  }, 120_000);

  it('roosts a tired mangabey 20 m up in the limbs', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { agile_mangabey: 1 }, minPopulation: {}, retainEvents: 'all' });
    const patch = world.patches.find((p) => p.habitat === 'terra_firme' && treeAnchorForPatch(world.grid, p))!;
    const anchor = treeAnchorForPatch(world.grid, patch)!, monkey = world.agents[0]!;
    Object.assign(monkey, { patchId: patch.id, position: { x: anchor.x + 3, z: anchor.z, heading: 0 }, dependentOn: null, pregnantSince: null,
      offspringIds: [], drives: { hunger: 0, thirst: 0, fatigue: 0.95, fear: 0 } });
    world.step(1);
    expect(monkey.altitudeM).toBe(20);
    expect(world.log.all().find((e) => e.type === 'tree_climbed' && e.actors[0] === monkey.id)!.effects.verticalDistanceM).toBe(20);
  }, 120_000);
});
