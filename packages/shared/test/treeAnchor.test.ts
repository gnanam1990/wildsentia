import { describe, expect, it } from 'vitest';
import { patchAtPosition, positionInPatch, treeAnchorForPatch, treeAnchorGeometry,
  treeAnchorRemnantForPatch, PATCH_COUNT } from '../src/index.js';

describe('versioned tree anchor', () => {
  const patch = { id: 210, habitat: 'shola', canopyCover: 0.8, surface: 'land' as const };

  it('is deterministic, in-patch and unaffected by dynamic patch resources', () => {
    const anchor = treeAnchorForPatch(patch)!;
    expect(anchor).toMatchObject({ version: 1, id: 'tree-v1:210', patchId: 210,
      climbHeightM: 6, visualKind: 'CommonTree_1', visualScale: 1.8 });
    expect(positionInPatch({ ...anchor, heading: 0 }, patch.id)).toBe(true);
    expect(patchAtPosition({ ...anchor, heading: 0 })).toBe(patch.id);
    expect(treeAnchorForPatch({ ...patch, canopyCover: 0.65 })).toEqual(anchor);
    expect(treeAnchorForPatch({ ...patch, habitat: 'riparian' })?.visualKind).toBe('TwistedTree_1');
  });

  it('keeps geometry addressable when canopy falls but prevents a new ascent', () => {
    const before = treeAnchorForPatch(patch)!;
    const depleted = { ...patch, canopyCover: 0 };
    expect(treeAnchorForPatch(depleted)).toBeNull();
    expect(treeAnchorRemnantForPatch(depleted)).toEqual(treeAnchorGeometry(patch.id));
    expect(treeAnchorGeometry(patch.id)).toMatchObject({ id: before.id, x: before.x, z: before.z,
      climbHeightM: before.climbHeightM });
    expect(treeAnchorRemnantForPatch({ ...depleted, surface: 'coast' })).toBeNull();
  });

  it('does not offer trunks on sea, non-wooded habitat or invalid patch ids', () => {
    expect(treeAnchorForPatch({ ...patch, surface: 'ocean' })).toBeNull();
    expect(treeAnchorForPatch({ ...patch, habitat: 'water' })).toBeNull();
    expect(treeAnchorRemnantForPatch({ ...patch, canopyCover: undefined })).toBeNull();
    expect(treeAnchorGeometry(-1)).toBeNull();
    expect(treeAnchorGeometry(PATCH_COUNT)).toBeNull();
  });
});
