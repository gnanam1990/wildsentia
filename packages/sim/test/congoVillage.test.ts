import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONGO_GRID, inCongoChannel, isCommunityState, isWorldPosition } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const CONGO_DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const options = { seed: 7, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1' as const, communityProfile: 'household_v1' as const,
  initialAgents: { blue_duiker: 300 }, minPopulation: {} };

// 2B: the island's village engine runs on the Congo forest's own 48 km grid: a home clear of the
// rivers, footpaths that do not wade a channel, and a checkpoint that validates on that grid.
describe('a village in the Congo forest', () => {
  it('is founded on dry forest ground clear of the rivers, lives a day, and survives a checkpoint', () => {
    const world = createWorld(options);
    const village = world.community!;
    expect(village).toBeTruthy();
    const home = village.building.position;
    expect(isWorldPosition(CONGO_GRID, home)).toBe(true);
    expect(inCongoChannel(CONGO_GRID, 7, home.x, home.z)).toBe(false);
    world.step(24);
    const people = world.community!.people.filter((p) => p.alive);
    expect(people.length).toBeGreaterThan(0);
    for (const p of people) {
      expect(isWorldPosition(CONGO_GRID, p.position)).toBe(true);
      expect(inCongoChannel(CONGO_GRID, 7, p.position.x, p.position.z)).toBe(false);
    }
    expect(isCommunityState(world.community, CONGO_GRID)).toBe(true);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(world))), options);
    expect(restored.community!.people.length).toBe(world.community!.people.length);
  }, 300_000);
});
