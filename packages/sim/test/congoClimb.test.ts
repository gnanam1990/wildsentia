import { describe, expect, it } from 'vitest';
import { CONGO_GRID, gridForProfile, congoChannelHalfM, congoRivers, riverIndex, treeAnchorForPatch, treeAnchorGeometry, treeAnchorRemnantForPatch } from '@vana/shared';
import { buildGrid } from '../src/grid.js';

// A climbing cat goes up its patch's tree anchor. On seed 7, 45 of 19,115 Congo anchors stood in
// a river channel: no tree stands there (the forest draws none), so none may be climbed.
describe('Congo climb trees and the rivers', () => {
  it('has no climbable tree in a river channel, and the island keeps every anchor', () => {
    const patches = buildGrid(7, 'congo_v1'), near = riverIndex(congoRivers(7, CONGO_GRID));
    const wet = (x: number, z: number) => { const at = near(x, z); return at.distanceM <= congoChannelHalfM(at.river, CONGO_GRID) + 3; };
    let anchors = 0, inChannel = 0;
    for (const p of patches) {
      const g = treeAnchorGeometry(CONGO_GRID, p.id)!;
      const a = treeAnchorForPatch(CONGO_GRID, p);
      if (a) { anchors++; expect(wet(a.x, a.z)).toBe(false); }
      else if (wet(g.x, g.z) && p.canopyCover >= 0.3 && ['terra_firme', 'flooded_forest'].includes(p.habitat)) {
        inChannel++;
        // Still addressable, so a cat saved up there before this rule can climb down.
        expect(treeAnchorRemnantForPatch(CONGO_GRID, p)).not.toBeNull();
      }
    }
    expect(anchors).toBeGreaterThan(19_000);
    expect(inChannel).toBeGreaterThan(0);
    const island = buildGrid(7, 'island_v2');
    expect(island.filter((p) => treeAnchorForPatch(gridForProfile('island_v2'), p)).length).toBeGreaterThan(0);
  }, 120_000);
});
