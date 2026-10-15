import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { patchCentre, waterAccessPosition, type Agent } from '@vana/shared';
import { createWorld } from '../src/world.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

/** A golden cat and a blue duiker, thirsty, at opposite corners of a patch with water, about 400 m apart. */
function converging(thirst: number) {
  const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
    initialAgents: { african_golden_cat: 1, blue_duiker: 1 }, minPopulation: {}, retainEvents: 'all' });
  const cols = world.grid.cols;
  const water = world.patches.find((p) => p.habitat === 'flooded_forest' && p.waterVolume > 10_000
    && !['water', undefined].includes(world.patches[p.id - 1]?.habitat) && !['water', undefined].includes(world.patches[p.id + 1]?.habitat) && p.id % cols > 1 && p.id % cols < cols - 2)!;
  const cat = world.agents.find((a) => a.speciesId === 'african_golden_cat')!;
  const duiker = world.agents.find((a) => a.speciesId === 'blue_duiker')!;
  const place = (a: Agent, d: number) => {
    const c = patchCentre(world.grid, water.id);
    Object.assign(a, { patchId: water.id, position: { x: c.x + d, z: c.z + d, heading: 0 }, dependentOn: null, pregnantSince: null,
      offspringIds: [], drives: { hunger: 0, thirst, fatigue: 0, fear: 0 } });
  };
  place(duiker, -145); place(cat, 145);
  return { world, water, cat, duiker };
}

// A hunter and its prey never drink side by side: whichever comes to the water second holds
// back that hour (unless desperate), as a duiker will not drink beside a golden cat.
describe('hunter and hunted at the water', () => {
  it('never both drink within 15 m of one access point in one hour', () => {
    const { world, water, cat, duiker } = converging(0.6);
    world.step(1);
    const drank = world.log.all().filter((e) => e.type === 'drank' && e.patchId === water.id).map((e) => e.actors[0]);
    const source = waterAccessPosition(world.grid, water.id, world.patches);
    const near = (a: Agent) => Math.hypot(a.position!.x - source.x, a.position!.z - source.z) <= 15;
    expect(drank.includes(cat.id) && drank.includes(duiker.id)).toBe(false);
    expect(near(cat) && near(duiker)).toBe(false);
  }, 120_000);

  it('keeps prey from the water where a crocodile lies, though it takes only their young', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { dwarf_crocodile: 1, blue_duiker: 1 }, minPopulation: {}, retainEvents: 'all' });
    const water = world.patches.find((p) => p.habitat === 'flooded_forest' && p.waterVolume > 10_000)!;
    const source = waterAccessPosition(world.grid, water.id, world.patches), c = patchCentre(world.grid, water.id);
    const croc = world.agents.find((a) => a.speciesId === 'dwarf_crocodile')!, duiker = world.agents.find((a) => a.speciesId === 'blue_duiker')!;
    Object.assign(croc, { patchId: water.id, position: { x: source.x + 1, z: source.z, heading: 0 }, offspringIds: [],
      drives: { hunger: 0, thirst: 0, fatigue: 0.9, fear: 0 } });
    Object.assign(duiker, { patchId: water.id, position: { x: c.x - 145, z: c.z - 145, heading: 0 }, dependentOn: null, pregnantSince: null,
      offspringIds: [], drives: { hunger: 0, thirst: 0.6, fatigue: 0, fear: 0 } });
    world.step(1);
    expect(world.log.all().some((e) => e.type === 'drank' && e.actors[0] === duiker.id && e.patchId === water.id)).toBe(false);
  }, 120_000);

  it('drink side by side only when one is desperate for water', () => {
    const { world, water, cat, duiker } = converging(0.95);
    world.step(1);
    const drank = world.log.all().filter((e) => e.type === 'drank' && e.patchId === water.id).map((e) => e.actors[0]);
    expect(drank).toContain(cat.id); expect(drank).toContain(duiker.id);
  }, 120_000);
});
