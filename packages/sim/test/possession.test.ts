import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { WORLD_SECONDS_PER_DAY, landWalkable, patchCentre, waterAccessPosition, type Agent } from '@vana/shared';
import { createWorld, type World } from '../src/world.js';
import { perceive } from '../src/agents/perception.js';
import { assertNutrientsConserved } from '../src/fields/nutrients.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

function island(initialAgents: Record<string, number> = { sambar: 10, tiger: 1 }): World {
  return createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents, minPopulation: {} });
}
const adults = (world: World, species: string): Agent[] =>
  world.agents.filter((a) => a.alive && a.speciesId === species && (a.lifeStage === 'adult' || a.lifeStage === 'elder')
    && a.dependentOn === null && !world.agents.some((c) => c.alive && c.dependentOn === a.id));

describe('agent-steered animals', () => {
  it('lets agents take only independent adults, and a fifth of a species at most', () => {
    const world = island();
    const [first, second, third] = adults(world, 'sambar');
    expect(world.possess(first!.id, 'agent_a')).toBeNull();
    expect(world.possess(first!.id, 'agent_b')).toBe('already_controlled');
    expect(world.possess(second!.id, 'agent_b')).toBeNull();
    expect(world.possess(third!.id, 'agent_c')).toBe('species_cap'); // 10 sambar: two may be held.
    // A lone tiger stays wild; with two, one may be steered (predators since Phase 2).
    const tiger = world.agents.find((a) => a.speciesId === 'tiger')!;
    expect(world.possessionBlock(tiger.id)).toBe('species_cap');
    expect(world.possessionBlock('nobody')).toBe('not_alive');
    world.release(first!.id);
    expect(world.possess(third!.id, 'agent_c')).toBeNull();
  });

  it('leaves the animal where its agent put it, while its body still hungers and ages', () => {
    const world = island({ sambar: 10 });
    const animal = adults(world, 'sambar')[0]!;
    expect(world.possess(animal.id, 'agent_a')).toBeNull();
    const before = { ...animal.position! }, hunger = animal.drives.hunger, age = animal.ageDays;
    for (let h = 0; h < 6; h++) world.step(1);
    expect(animal.position).toMatchObject({ x: before.x, z: before.z });
    expect(animal.drives.hunger).toBeGreaterThan(hunger);
    expect(animal.ageDays).toBeCloseTo(age + 0.25);
    expect(animal.controller).toBe('agent_a');
  });

  it('moves only onto walkable land, never to an invalid spot', () => {
    const world = island({ sambar: 10 });
    const animal = adults(world, 'sambar')[0]!;
    world.possess(animal.id, 'agent_a');
    const land = world.patches.find((p) => landWalkable(p) && p.id !== animal.patchId)!;
    const centre = patchCentre(land.id);
    expect(world.placeControlled(animal.id, { ...centre, heading: 1 })).toBe(true);
    expect(animal.patchId).toBe(land.id);
    const sea = world.patches.find((p) => !landWalkable(p))!;
    expect(world.placeControlled(animal.id, { ...patchCentre(sea.id), heading: 0 })).toBe(false);
    expect(world.placeControlled(animal.id, { x: Number.NaN, z: 0, heading: 0 })).toBe(false);
    expect(animal.patchId).toBe(land.id);
    world.release(animal.id);
    expect(world.placeControlled(animal.id, { ...centre, heading: 0 })).toBe(false); // Wild again.
  });

  it('grazes from the patch it stands in, conserving every nutrient', () => {
    const world = island({ sambar: 10 });
    const animal = adults(world, 'sambar')[0]!;
    world.possess(animal.id, 'agent_a');
    animal.drives.hunger = 0.8;
    const patch = world.patches[animal.patchId]!, grass = patch.plant.grass + patch.plant.browse;
    const baseline = world.totalNutrients();
    expect(world.applyControlledAction(animal.id, 'graze', 600)).toBe(true);
    expect(animal.drives.hunger).toBeLessThan(0.8);
    expect(patch.plant.grass + patch.plant.browse).toBeLessThan(grass);
    expect(animal.state).toBe('grazing');
    assertNutrientsConserved(baseline, world.totalNutrients());
  });

  it('drinks only at the water access point it walked to', () => {
    const world = island({ sambar: 10 });
    const animal = adults(world, 'sambar')[0]!;
    world.possess(animal.id, 'agent_a');
    const wet = world.patches.filter((p) => landWalkable(p)).sort((a, b) => b.waterVolume - a.waterVolume)[0]!;
    expect(wet.waterVolume).toBeGreaterThan(0);
    const access = waterAccessPosition(wet.id);
    world.placeControlled(animal.id, { x: access.x + 20, z: access.z, heading: 0 });
    animal.drives.thirst = 0.6;
    world.applyControlledAction(animal.id, 'drink', 300);
    expect(animal.drives.thirst).toBe(0.6); // Twenty metres off: not drinking.
    world.placeControlled(animal.id, { x: access.x + 1, z: access.z, heading: 0 });
    const water = wet.waterVolume;
    world.applyControlledAction(animal.id, 'drink', 300);
    expect(animal.drives.thirst).toBeLessThan(0.6);
    expect(wet.waterVolume).toBeLessThan(water);
  });

  it('is not hunted or courted by the hourly plans of wild animals', () => {
    const world = island({ sambar: 10, tiger: 1 });
    const animal = adults(world, 'sambar')[0]!, tiger = world.agents.find((a) => a.speciesId === 'tiger')!;
    world.step(1);
    // Place the tiger beside it after the step: since sim_0.34.0 a sambar that sees a tiger
    // beside it runs, so a tiger placed before the step would no longer have it in view.
    tiger.patchId = animal.patchId; tiger.position = { ...animal.position!, x: animal.position!.x + 3 };
    world.__reindexForTest();
    const cfg = world.species.get('tiger')!;
    expect(perceive(tiger, cfg, world.__viewForTest()).prey.some((p) => p.agent.id === animal.id)).toBe(true);
    world.possess(animal.id, 'agent_a');
    expect(perceive(tiger, cfg, world.__viewForTest()).prey.some((p) => p.agent.id === animal.id)).toBe(false);
  });

  it('keeps the controller through a snapshot, and a mother goes back to the wild at birth', () => {
    const world = island({ sambar: 10 });
    const mother = adults(world, 'sambar').find((a) => a.sex === 'female')!;
    world.possess(mother.id, 'agent_a');
    const copy = restoreSnapshot(takeSnapshot(world), { seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { sambar: 10 }, minPopulation: {} });
    expect(copy.agents.find((a) => a.id === mother.id)!.controller).toBe('agent_a');

    const gestation = world.species.get('sambar')!.lifecycle.gestationDays!;
    mother.pregnantSince = world.now() - gestation * WORLD_SECONDS_PER_DAY;
    mother.pregnancyFatherId = adults(world, 'sambar').find((a) => a.sex === 'male')?.id ?? null;
    world.step(1);
    expect(world.agents.some((a) => a.dependentOn === mother.id)).toBe(true);
    expect(mother.controller).toBeUndefined();
  });
});
