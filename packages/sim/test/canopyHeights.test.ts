import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONGO_GRID, ISLAND_GRID, treeAnchorGeometry } from '@vana/shared';
import { createWorld } from '../src/world.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

// The owner: eagles went inside the trees. The Congo's canopy stands about 29 m, its emergents
// 44 m; a canopy tree's crown is 25-34 m, its limbs 23-30 m (congoPlants.ts).
describe('heights in the Congo canopy', () => {
  it('perches an eagle on top of a crown, and a monkey among the limbs', () => {
    const tree = treeAnchorGeometry(CONGO_GRID, 30 * 160 + 30)!;
    expect(tree.perchHeightM).toBe(34);
    expect(tree.climbHeightM).toBe(28);
    const island = treeAnchorGeometry(ISLAND_GRID, 210)!;
    expect(island.perchHeightM).toBe(island.climbHeightM);
  });

  it('flies an eagle over the canopy, not through it, and lands it on a crown', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { crowned_eagle: 30, agile_mangabey: 30 }, minPopulation: {}, retainEvents: 'all' });
    for (let h = 0; h < 72; h++) world.step(1);
    const flights = world.log.all().filter((e) => e.actors[0]?.startsWith('crowned_eagle') && e.movement
      && e.movement.samples.some((s) => (s.altitudeM ?? 0) > 0));
    expect(flights.length).toBeGreaterThan(20);
    let cruising = 0;
    for (const e of flights) {
      const samples = e.movement!.samples;
      // Between take-off and landing, the bird is above the emergents.
      for (const s of samples.slice(1, -1)) { expect(s.altitudeM ?? 0).toBeGreaterThanOrEqual(55); cruising++; }
      if (e.conditions.reason === 'perch' && e.outcome === 'success') expect(samples.at(-1)!.altitudeM).toBe(34);
    }
    expect(cruising).toBeGreaterThan(20);
    for (const a of world.agents) {
      if (!a.alive || a.locomotionMode !== 'climb') continue;
      if (a.speciesId === 'crowned_eagle') expect(a.altitudeM).toBe(34);
      if (a.speciesId === 'agile_mangabey' && a.dependentOn === null) expect(a.altitudeM!).toBeGreaterThan(23);
    }
  }, 240_000);
});
