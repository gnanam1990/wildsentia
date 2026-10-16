import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { patchCentre } from '@vana/shared';
import { createWorld } from '../src/world.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

/** A blue duiker with a sated, resting leopard `gapM` away on dry forest. */
function nearLeopard(gapM: number) {
  const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
    initialAgents: { blue_duiker: 1, african_leopard: 1 }, minPopulation: {}, retainEvents: 'all' });
  const patch = world.patches.find((p) => p.habitat === 'terra_firme' && p.flooded !== true)!, c = patchCentre(world.grid, patch.id);
  const duiker = world.agents.find((a) => a.speciesId === 'blue_duiker')!, leopard = world.agents.find((a) => a.speciesId === 'african_leopard')!;
  Object.assign(duiker, { patchId: patch.id, position: { x: c.x, z: c.z, heading: 0 }, dependentOn: null, pregnantSince: null, offspringIds: [],
    drives: { hunger: 0.1, thirst: 0.1, fatigue: 0, fear: 0.9 } });
  Object.assign(leopard, { patchId: patch.id, position: { x: c.x + gapM, z: c.z, heading: 0 }, state: 'resting', currentGoal: 'rest',
    drives: { hunger: 0, thirst: 0, fatigue: 0.9, fear: 0 } });
  return { world, duiker, start: { ...duiker.position! } };
}

// A duiker that has seen a predator first goes still (escape.freezeFirst), and bolts only when it
// comes closer than its flight distance or is hunting it (docs/2026-10-15-congo-species-behaviour-audit.md).
describe('a freezer freezes first', () => {
  it('holds still while a resting leopard is beyond its flight distance', () => {
    const { world, duiker, start } = nearLeopard(25);
    world.step(1);
    const mine = world.log.all().filter((e) => e.actors[0] === duiker.id);
    expect(mine.some((e) => e.type === 'fled')).toBe(false);
    expect(mine.some((e) => e.type === 'rested' && e.conditions.reason === 'froze')).toBe(true);
    expect(Math.hypot(duiker.position!.x - start.x, duiker.position!.z - start.z)).toBeLessThan(1);
  }, 120_000);

  it('bolts when the leopard is within its flight distance', () => {
    const { world, duiker } = nearLeopard(8);
    world.step(1);
    expect(world.log.all().some((e) => e.type === 'fled' && e.actors[0] === duiker.id)).toBe(true);
  }, 120_000);
});
