import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { patchCentre, treeAnchorForPatch } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const options = { seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1' as const, minPopulation: {}, retainEvents: 'all' as const };

// Where an animal rests: a crowned eagle on a branch, a dwarf crocodile in the water by day
// (docs/2026-10-15-congo-species-behaviour-audit.md).
describe('resting places', () => {
  it('perches a resting crowned eagle in its patch\'s tree, and a hungry one leaves it by day', () => {
    const world = createWorld({ ...options, initialAgents: { crowned_eagle: 1 } });
    const patch = world.patches.find((p) => p.habitat === 'terra_firme' && treeAnchorForPatch(world.grid, p))!;
    const anchor = treeAnchorForPatch(world.grid, patch)!, c = patchCentre(world.grid, patch.id), eagle = world.agents[0]!;
    Object.assign(eagle, { patchId: patch.id, position: { x: c.x + 40, z: c.z + 30, heading: 0 }, dependentOn: null, pregnantSince: null,
      offspringIds: [], drives: { hunger: 0, thirst: 0, fatigue: 0.95, fear: 0 } });
    world.step(1);
    expect(eagle.altitudeM).toBe(anchor.climbHeightM);
    expect(eagle.locomotionMode).toBe('climb');
    expect(eagle.treeAnchorId).toBe(anchor.id);
    expect(eagle.position!.x).toBeCloseTo(anchor.x, 6); expect(eagle.position!.z).toBeCloseTo(anchor.z, 6);
    const perch = world.log.all().find((e) => e.actors[0] === eagle.id && e.conditions.reason === 'perch')!;
    expect(perch.movement!.samples.at(-1)!.altitudeM).toBe(anchor.climbHeightM);
    // A perched eagle is a valid checkpoint.
    expect(() => restoreSnapshot(takeSnapshot(world), { ...options, initialAgents: {} })).not.toThrow();
    // It roosts through the night (a diurnal hunter) and leaves the branch to hunt by day.
    eagle.drives.hunger = 0.95; eagle.drives.fatigue = 0;
    let left = false;
    for (let h = 0; h < 14 && !left; h++) { world.step(1); left = eagle.locomotionMode !== 'climb'; }
    expect(left).toBe(true);
  }, 120_000);

  it('rests a dwarf crocodile under water by day', () => {
    const world = createWorld({ ...options, initialAgents: { dwarf_crocodile: 1 } });
    const croc = world.agents[0]!;
    world.step(12); // to noon
    expect(croc.alive).toBe(true);
    const water = world.patches.find((p) => p.habitat === 'flooded_forest')!;
    const c = patchCentre(world.grid, water.id);
    Object.assign(croc, { patchId: water.id, position: { x: c.x, z: c.z, heading: 0 }, dependentOn: null, pregnantSince: null,
      offspringIds: [], drives: { hunger: 0, thirst: 0, fatigue: 0.9, fear: 0 } });
    delete croc.locomotionMode; delete croc.submergedUntil;
    world.step(1);
    expect(croc.locomotionMode).toBe('submerged');
    expect(world.log.all().some((e) => e.actors[0] === croc.id && e.type === 'rested' && e.conditions.reason === 'submerged')).toBe(true);
  }, 120_000);
});
