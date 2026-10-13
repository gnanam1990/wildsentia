import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/world.js';
import { islandPopulation } from '../src/forest.js';
import { SPECIES_DIR } from './helpers.js';

const island = () => createWorld({ seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2', initialAgents: islandPopulation('island_v2'), minPopulation: {} });
const fingerprint = (w: World) => JSON.stringify([w.now(), w.log.all().map((e) => [e.id, e.type, e.patchId, e.actors]), w.agents.map((a) => [a.id, a.position, a.drives])]);

describe('a step in slices', () => {
  it('drained, is exactly the step', () => {
    const a = island(), b = island();
    a.step(6);
    let slices = 0;
    for (const _ of b.stepSlices(6)) slices++;
    expect(slices).toBeGreaterThan(6);
    expect(fingerprint(b)).toBe(fingerprint(a));
  }, 60_000);

  it('never runs long between yields on the Congo stand-in world', () => {
    const world = createWorld({ seed: 7, speciesDir: SPECIES_DIR, terrainProfile: 'congo_v1',
      initialAgents: { hare: 45_000, chital: 3_000, leopard: 150 }, minPopulation: {}, retainEvents: 5_000 });
    world.step(1);
    let longest = 0, yields = 0, at = performance.now();
    for (const _ of world.stepSlices(2)) {
      const now = performance.now(); longest = Math.max(longest, now - at); at = now; yields++;
    }
    console.log(`congo slices: ${yields} yields, longest ${longest.toFixed(1)} ms`);
    expect(longest).toBeLessThan(Number(process.env.VANA_CONGO_SLICE_MAX_MS ?? 60));
  }, 300_000);
});
