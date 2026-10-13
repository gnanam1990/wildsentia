import { describe, expect, it } from 'vitest';
import { patchAtPosition, positionInPatch, treeAnchorForPatch, treeAnchorGeometry, treeAnchorRemnantForPatch } from '../src/index.js';
import { ISLAND_GRID, patchCount } from '../src/grid.js';

describe('versioned tree anchor', () => {
  const patch = { id: 210, habitat: 'shola', canopyCover: 0.8, surface: 'land' as const };

  it('is deterministic, in-patch and unaffected by dynamic patch resources', () => {
    const anchor = treeAnchorForPatch(ISLAND_GRID, patch)!;
    expect(anchor).toMatchObject({ version: 1, id: 'tree-v1:210', patchId: 210,
      climbHeightM: 6, visualKind: 'CommonTree_1', visualScale: 1.8 });
    expect(positionInPatch(ISLAND_GRID, { ...anchor, heading: 0 }, patch.id)).toBe(true);
    expect(patchAtPosition(ISLAND_GRID, { ...anchor, heading: 0 })).toBe(patch.id);
    expect(treeAnchorForPatch(ISLAND_GRID, { ...patch, canopyCover: 0.65 })).toEqual(anchor);
    expect(treeAnchorForPatch(ISLAND_GRID, { ...patch, habitat: 'riparian' })?.visualKind).toBe('TwistedTree_1');
  });

  it('keeps geometry addressable when canopy falls but prevents a new ascent', () => {
    const before = treeAnchorForPatch(ISLAND_GRID, patch)!;
    const depleted = { ...patch, canopyCover: 0 };
    expect(treeAnchorForPatch(ISLAND_GRID, depleted)).toBeNull();
    expect(treeAnchorRemnantForPatch(ISLAND_GRID, depleted)).toEqual(treeAnchorGeometry(ISLAND_GRID, patch.id));
    expect(treeAnchorGeometry(ISLAND_GRID, patch.id)).toMatchObject({ id: before.id, x: before.x, z: before.z,
      climbHeightM: before.climbHeightM });
    expect(treeAnchorRemnantForPatch(ISLAND_GRID, { ...depleted, surface: 'coast' })).toBeNull();
  });

  it('does not offer trunks on sea, non-wooded habitat or invalid patch ids', () => {
    expect(treeAnchorForPatch(ISLAND_GRID, { ...patch, surface: 'ocean' })).toBeNull();
    expect(treeAnchorForPatch(ISLAND_GRID, { ...patch, habitat: 'water' })).toBeNull();
    expect(treeAnchorRemnantForPatch(ISLAND_GRID, { ...patch, canopyCover: undefined })).toBeNull();
    expect(treeAnchorGeometry(ISLAND_GRID, -1)).toBeNull();
    expect(treeAnchorGeometry(ISLAND_GRID, patchCount(ISLAND_GRID))).toBeNull();
  });
});
