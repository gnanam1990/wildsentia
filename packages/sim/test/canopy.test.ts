import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONGO_GRID, treeAnchorForPatch } from '@vana/shared';
import { createWorld } from '../src/world.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

// The agile mangabey lives in the canopy: it rests and sleeps up its patch's tree and comes down
// to forage and drink (on the ground some 12-22% of its time; docs/2026-10-14-congo-phase-b-research.md).
describe('a canopy dweller lives up its tree', () => {
  it('rests aloft and comes down to forage, most hours in the tree', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { agile_mangabey: 60 }, minPopulation: {}, retainEvents: 'all' });
    let aloft = 0, hours = 0;
    for (let h = 0; h < 24 * 6; h++) {
      world.step(1);
      for (const a of world.agents) if (a.alive && a.speciesId === 'agile_mangabey'
        && a.dependentOn === null && a.pregnantSince === null) { hours++; if ((a.altitudeM ?? 0) > 0) aloft++; }
    }
    expect(aloft / hours).toBeGreaterThan(0.6);

    const climbs = world.log.all().filter((e) => e.type === 'tree_climbed');
    const roosts = climbs.filter((e) => e.conditions.reason === 'roost');
    const forays = climbs.filter((e) => e.conditions.reason === 'forage');
    expect(roosts.length).toBeGreaterThan(0);
    expect(forays.length).toBeGreaterThan(0);
    for (const e of roosts) {
      expect(e.conditions.direction).toBe('ascend');
      expect(e.goal).toBe('rest');
      expect(e.movement!.goal).toBe('rest');
      expect(treeAnchorForPatch(CONGO_GRID, world.patches[e.movement!.destinationPatchId]!)).not.toBeNull();
    }
    for (const e of forays) { expect(e.conditions.direction).toBe('descend'); expect(e.goal).toBe('rest'); }
  }, 240_000);
});
