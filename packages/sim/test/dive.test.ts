import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { cardinalNeighbours, waterAccessPosition } from '@vana/shared';
import { createWorld, type World } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { canHunt } from '../src/agents/perception.js';
import { islandPopulation } from '../src/forest.js';
import { SPECIES_DIR } from './helpers.js';

const CONGO_DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const congo = () => createWorld({ seed: 7, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1',
  initialAgents: { african_leopard: 2, water_chevrotain: 3 }, minPopulation: {} });

/** A chevrotain on dry ground beside a river patch, with a hungry leopard in the same patch. */
function stage(world: World) {
  const chevrotain = world.agents.find((a) => a.speciesId === 'water_chevrotain')!;
  const leopard = world.agents.find((a) => a.speciesId === 'african_leopard')!;
  const bank = world.patches.find((p) => p.habitat === 'flooded_forest' && cardinalNeighbours(world.grid, p.id).some((n) => world.patches[n]!.habitat === 'water'))!;
  const shore = waterAccessPosition(world.grid, cardinalNeighbours(world.grid, bank.id).find((n) => world.patches[n]!.habitat === 'water')!, world.patches);
  const centre = { x: bank.x * world.grid.patchM, z: bank.y * world.grid.patchM };
  for (const [a, dx] of [[chevrotain, 0], [leopard, 8]] as const) {
    a.patchId = bank.id; a.position = { x: centre.x + dx, z: centre.z, heading: 0 }; delete a.journey;
  }
  // A sated chevrotain (nothing to do but get away) beside a leopard on the move.
  chevrotain.drives.thirst = 0; chevrotain.drives.hunger = 0; chevrotain.drives.fear = 0.9;
  leopard.state = 'travelling'; leopard.currentGoal = 'wander';
  return { chevrotain, leopard, shore };
}

describe('the water chevrotain dives to escape (1B)', () => {
  it('dives when a predator is on it and water is in reach, and is then beyond any hunter', () => {
    const world = congo(), { chevrotain, leopard } = stage(world);
    world.step(1);
    const dive = world.log.all().find((e) => e.type === 'fled' && e.actors[0] === chevrotain.id && e.conditions.escape === 'dive');
    expect(dive, 'a recorded dive').toBeDefined();
    expect(chevrotain.locomotionMode).toBe('submerged');
    expect(chevrotain.submergedUntil).toBeGreaterThan(world.now() - 3600);
    const cfg = world.species.get('african_leopard')!, prey = world.species.get('water_chevrotain')!;
    expect(canHunt(cfg, prey, chevrotain)).toBe(false);
    expect(world.resolveLiveHunt(leopard.id, chevrotain.id, chevrotain.position!, world.now(), true)).toBeNull();
  }, 120_000);

  it('surfaces when its dive ends, and a checkpoint taken under water round-trips', () => {
    const world = congo(), { chevrotain, leopard } = stage(world);
    world.step(1);
    expect(chevrotain.locomotionMode).toBe('submerged');
    // The leopard moves off: once its dive ends there is nothing to dive from again.
    leopard.patchId = 0; leopard.position = { x: 0, z: 0, heading: 0 }; delete leopard.journey;
    const saved = takeSnapshot(world);
    const back = restoreSnapshot(saved, { seed: 7, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1', initialAgents: {}, minPopulation: {} });
    expect(back.animal(chevrotain.id)!.locomotionMode).toBe('submerged');
    world.step(1);
    expect(chevrotain.locomotionMode).toBeUndefined();
    expect(chevrotain.submergedUntil).toBeUndefined();
  }, 120_000);

  it('never makes an island animal dive', () => {
    const world = createWorld({ seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2', initialAgents: islandPopulation('island_v2'), minPopulation: {} });
    world.step(48);
    expect(world.log.all().some((e) => e.conditions.escape === 'dive')).toBe(false);
    expect(world.agents.some((a) => a.locomotionMode === 'submerged')).toBe(false);
  }, 120_000);
});
