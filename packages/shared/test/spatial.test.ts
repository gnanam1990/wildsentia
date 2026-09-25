import { describe, expect, it } from 'vitest';
import { initialPosition, isWorldPosition, patchAtPosition, positionInPatch, PATCH_COUNT, subPatchOffset } from '../src/index.js';

describe('shared spatial contract', () => {
  it('initializes finite positions inside every patch, without RNG', () => {
    for (let patch = 0; patch < PATCH_COUNT; patch++) {
      const position = initialPosition('tiger_0001', patch);
      expect(positionInPatch(position, patch)).toBe(true);
      expect(patchAtPosition(position)).toBe(patch);
      expect(initialPosition('tiger_0001', patch)).toEqual(position);
    }
  });
  it('assigns patch boundaries consistently and rejects the excluded upper world edge', () => {
    expect(patchAtPosition({ x: -150, z: -150, heading: 0 })).toBe(0);
    expect(patchAtPosition({ x: 150, z: 0, heading: 0 })).toBe(1);
    expect(patchAtPosition({ x: 0, z: 150, heading: 0 })).toBe(20);
    expect(patchAtPosition({ x: 5849.999, z: 5849.999, heading: 0 })).toBe(399);
    expect(() => patchAtPosition({ x: 5850, z: 0, heading: 0 })).toThrow();
  });
  it('does not mistake NaN, partial, outside-world or wrong-patch positions for precise data', () => {
    for (const bad of [null, {}, { x: 0, z: 0 }, { x: NaN, z: 0, heading: 0 },
      { x: 0, z: Infinity, heading: 0 }, { x: 6000, z: 0, heading: 0 }, { x: 0, z: 0, heading: 4 }]) {
      expect(isWorldPosition(bad)).toBe(false);
    }
    expect(positionInPatch({ x: 0, z: 0, heading: 0 }, 1)).toBe(false);
    expect(positionInPatch(initialPosition('a', 0), -1)).toBe(false);
  });
  it('retains legacy offset identity when initializing new server positions', () => {
    expect(initialPosition('a', 0)).toEqual({ ...subPatchOffset('a'), heading: 0 });
  });
});
