import { createHash } from 'node:crypto';
import { treeAnchorGeometry } from '@vana/shared';
import { describe, expect, it } from 'vitest';
import { canopyField, NEAR_RADIUS_M, TREE_DETAIL_RADIUS_M, nearPlan, planVegetation,
  type PlacedPlant } from '../src/vegetation.js';
import type { PatchView } from '../src/terrain.js';

const patch = (id: number, habitat: string, canopyCover = .8): PatchView => ({
  id, x: id % 20, y: Math.floor(id / 20), habitat, grass: 6000, browse: 3000,
  water: 0, canopyCover, surface: 'land',
});
const legacyNear = (patches: PatchView[], focus: { x: number; z: number }, groundAt: () => number) => {
  const plan = planVegetation(patches, focus, NEAR_RADIUS_M, groundAt, { canopyAt: canopyField(patches) });
  for (const [kind, items] of plan) {
    const radius = kind.includes('Tree') ? TREE_DETAIL_RADIUS_M : kind.startsWith('Grass') ? 90 : NEAR_RADIUS_M;
    plan.set(kind, items.filter(item => Math.hypot(item.x - focus.x, item.z - focus.z) <= radius));
  }
  return plan;
};
const digest = (plan: Map<string, PlacedPlant[]>) =>
  createHash('sha256').update(JSON.stringify([...plan])).digest('hex');

describe('near vegetation work before terrain seating', () => {
  it('retains exact tree, grass, stone and canopy-remnant placements while cutting offscreen height work', () => {
    const shola = Array.from({ length: 400 }, (_, id) => patch(id, 'shola'));
    const focus = { x: 2850, z: 2850 };
    let beforeSamples = 0, afterSamples = 0;
    const before = legacyNear(shola, focus, () => { beforeSamples++; return 10; });
    const after = nearPlan(shola, focus, () => { afterSamples++; return 10; });
    expect(digest(after)).toBe(digest(before));
    // Clumped stands (forestStructure.ts) keep every patch's count but move plants between
    // clumps and clearings, so the population inside this one 220 m circle changed
    // (4211 -> 3932); island-wide means are recorded in docs/2026-10-05-environment-realism.md.
    expect([...after.values()].reduce((count, items) => count + items.length, 0)).toBe(3932);
    expect(beforeSamples).toBe(23475);
    expect(afterSamples).toBe(8836);
    expect(afterSamples).toBeLessThan(beforeSamples * .5);

    shola[210]!.canopyCover = 0; // saved perch remnant is not dropped by an early patch cull.
    const trunk = treeAnchorGeometry(210)!;
    for (const here of [focus, { x: trunk.x, z: trunk.z }, { x: 3150, z: 3000 }]) {
      expect(digest(nearPlan(shola, here, () => 10))).toBe(digest(legacyNear(shola, here, () => 10)));
    }
  });

  it('keeps grassland and rocky foreground populations bit-for-bit stable around patch edges', () => {
    for (const habitat of ['grassland', 'rock', 'riparian']) {
      const patches = Array.from({ length: 400 }, (_, id) => patch(id, habitat, habitat === 'riparian' ? .5 : .1));
      for (const focus of [{ x: 0, z: 0 }, { x: 2849.5, z: 3150.5 }, { x: 5700, z: 5700 }]) {
        expect(digest(nearPlan(patches, focus, () => 4)))
          .toBe(digest(legacyNear(patches, focus, () => 4)));
      }
    }
  });
});
