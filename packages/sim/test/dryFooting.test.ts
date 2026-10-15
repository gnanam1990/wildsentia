import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inCongoChannel, landWalkable, patchCentre } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { planRoute, standingPoint } from '../src/agents/navigation.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

// Water kulla deer grass saptutu iruku (the owner): blue duikers grazed standing in the river.
describe('a land animal keeps its feet dry', () => {
  it('never stands in a river channel, while a swimmer may', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { blue_duiker: 1, sitatunga: 1 }, minPopulation: {} });
    const duiker = world.species.get('blue_duiker')!;
    // River patches with a bank to stand on (a patch that is all channel a duiker cannot enter).
    const banks = world.patches.filter((p) => p.habitat === 'water' && landWalkable(p)).filter((p) => {
      const c = patchCentre(world.grid, p.id);
      for (let x = -140; x <= 140; x += 20) for (let z = -140; z <= 140; z += 20) if (!inCongoChannel(world.grid, 7, c.x + x, c.z + z)) return true;
      return false;
    }).slice(0, 60);
    expect(banks.length).toBeGreaterThan(10);
    let checked = 0;
    for (const p of banks) for (let i = 0; i < 25; i++) {
      const at = standingPoint(world.grid, `agent_${i}`, p, duiker);
      expect(inCongoChannel(world.grid, 7, at.x, at.z)).toBe(false);
      checked++;
    }
    expect(checked).toBe(banks.length * 25);
  }, 120_000);

  it('cannot walk into a river patch that is all channel, as an elephant can', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { blue_duiker: 1, forest_elephant: 1 }, minPopulation: {} });
    const wide = world.patches.find((p) => p.habitat === 'water' && landWalkable(p) && p.neighbours.some((n) => world.patches[n]!.habitat !== 'water') && (() => {
      const c = patchCentre(world.grid, p.id);
      for (let x = -150; x <= 150; x += 10) for (let z = -150; z <= 150; z += 10) if (!inCongoChannel(world.grid, 7, c.x + x, c.z + z)) return false;
      return true;
    })())!;
    const shore = wide.neighbours.find((n) => world.patches[n]!.habitat !== 'water')!;
    for (const a of world.agents) Object.assign(a, { patchId: shore, position: { ...patchCentre(world.grid, shore), heading: 0 } });
    const [duiker, elephant] = [world.agents.find((a) => a.speciesId === 'blue_duiker')!, world.agents.find((a) => a.speciesId === 'forest_elephant')!];
    expect(planRoute(world.grid, duiker, wide.id, world.patches, world.species.get('blue_duiker')!)).toBeNull();
    expect(planRoute(world.grid, elephant, wide.id, world.patches, world.species.get('forest_elephant')!)).not.toBeNull();
  }, 120_000);

  it('takes a flood-shy duiker out of the flood to feed', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { blue_duiker: 1 }, minPopulation: {}, retainEvents: 'all' });
    const wet = world.patches.find((p) => p.habitat === 'flooded_forest' && p.neighbours.some((n) => world.patches[n]!.habitat === 'terra_firme'))!;
    wet.flooded = true;
    const duiker = world.agents[0]!, c = patchCentre(world.grid, wet.id);
    Object.assign(duiker, { patchId: wet.id, position: { x: c.x, z: c.z, heading: 0 }, dependentOn: null, pregnantSince: null,
      offspringIds: [], drives: { hunger: 0.6, thirst: 0, fatigue: 0, fear: 0 } });
    world.step(1);
    expect(world.patches[duiker.patchId]!.flooded).not.toBe(true);
  }, 120_000);
});
