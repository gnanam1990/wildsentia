import { describe, expect, it } from 'vitest';
import { initialPosition, isWorldPosition, patchAtPosition, positionInPatch, subPatchOffset } from '../src/index.js';
import { ISLAND_GRID, patchCount } from '../src/grid.js';

describe('shared spatial contract', () => {
  it('initializes finite positions inside every patch, without RNG', () => {
    for (let patch = 0; patch < patchCount(ISLAND_GRID); patch++) {
      const position = initialPosition(ISLAND_GRID, 'tiger_0001', patch);
      expect(positionInPatch(ISLAND_GRID, position, patch)).toBe(true);
      expect(patchAtPosition(ISLAND_GRID, position)).toBe(patch);
      expect(initialPosition(ISLAND_GRID, 'tiger_0001', patch)).toEqual(position);
    }
  });
  it('assigns patch boundaries consistently and rejects the excluded upper world edge', () => {
    expect(patchAtPosition(ISLAND_GRID, { x: -150, z: -150, heading: 0 })).toBe(0);
    expect(patchAtPosition(ISLAND_GRID, { x: 150, z: 0, heading: 0 })).toBe(1);
    expect(patchAtPosition(ISLAND_GRID, { x: 0, z: 150, heading: 0 })).toBe(20);
    expect(patchAtPosition(ISLAND_GRID, { x: 5849.999, z: 5849.999, heading: 0 })).toBe(399);
    expect(() => patchAtPosition(ISLAND_GRID, { x: 5850, z: 0, heading: 0 })).toThrow();
  });
  it('does not mistake NaN, partial, outside-world or wrong-patch positions for precise data', () => {
    for (const bad of [null, {}, { x: 0, z: 0 }, { x: NaN, z: 0, heading: 0 },
      { x: 0, z: Infinity, heading: 0 }, { x: 6000, z: 0, heading: 0 }, { x: 0, z: 0, heading: 4 }]) {
      expect(isWorldPosition(ISLAND_GRID, bad)).toBe(false);
    }
    expect(positionInPatch(ISLAND_GRID, { x: 0, z: 0, heading: 0 }, 1)).toBe(false);
    expect(positionInPatch(ISLAND_GRID, initialPosition(ISLAND_GRID, 'a', 0), -1)).toBe(false);
  });
  it('retains legacy offset identity when initializing new server positions', () => {
    expect(initialPosition(ISLAND_GRID, 'a', 0)).toEqual({ ...subPatchOffset(ISLAND_GRID, 'a'), heading: 0 });
  });
});
