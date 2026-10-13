import { describe, expect, it } from 'vitest';
import {
  CONGO_GRID, ISLAND_GRID, cardinalNeighbours, initialPosition, isEdgePatch, isWorldPosition, patchAtPosition,
  patchCentre, patchColRow, patchCount, patchIdAt, positionInPatch, regionIds, regionOfPatch, regionPatchIds,
  worldExtentM, type WorldGrid,
} from '../src/grid.js';

const ODD: WorldGrid = { cols: 4, rows: 3, patchM: 100, regionPatches: 2 };

describe('WorldGrid', () => {
  it('matches the island constants exactly', () => {
    expect(patchCount(ISLAND_GRID)).toBe(400);
    expect(patchCentre(ISLAND_GRID, 21)).toEqual({ x: 300, z: 300 });
    expect(patchAtPosition(ISLAND_GRID, { x: 449.99, z: 0, heading: 0 })).toBe(1);
    expect(worldExtentM(ISLAND_GRID)).toEqual({ min: -150, maxX: 5850, maxZ: 5850 });
  });

  it('is 48 km and 64 regions for Congo', () => {
    expect(patchCount(CONGO_GRID)).toBe(25_600);
    expect(worldExtentM(CONGO_GRID).maxX - worldExtentM(CONGO_GRID).min).toBe(48_000);
    expect(regionIds(CONGO_GRID)).toHaveLength(64);
    expect(regionOfPatch(CONGO_GRID, 0)).toBe('r0_0');
    expect(regionOfPatch(CONGO_GRID, 25_599)).toBe('r7_7');
    expect(regionPatchIds(CONGO_GRID, 'r1_0')).toHaveLength(400);
    expect(regionPatchIds(CONGO_GRID, 'r1_0')[0]).toBe(20);
  });

  it('indexes rows by columns on a non-square grid', () => {
    expect(patchCount(ODD)).toBe(12);
    expect(patchColRow(ODD, 5)).toEqual({ col: 1, row: 1 });
    expect(patchIdAt(ODD, 3, 2)).toBe(11);
    expect(patchIdAt(ODD, 4, 0)).toBeNull();
    expect(cardinalNeighbours(ODD, 5)).toEqual([4, 6, 1, 9]);
    expect(cardinalNeighbours(ODD, 0)).toEqual([1, 4]);
    expect(isEdgePatch(ODD, 5)).toBe(false);
    expect(isEdgePatch(ODD, 7)).toBe(true);
    expect(regionIds(ODD)).toEqual(['r0_0', 'r1_0', 'r0_1', 'r1_1']);
    expect(regionPatchIds(ODD, 'r1_1')).toEqual([10, 11]);
    expect(() => regionPatchIds(ODD, 'r9_9')).toThrow('outside the world');
    expect(() => regionPatchIds(ODD, 'north')).toThrow('invalid region id');
  });

  it('puts the far edge outside the world and just inside it within', () => {
    const edge = (ISLAND_GRID.cols - 0.5) * ISLAND_GRID.patchM;
    expect(isWorldPosition(ISLAND_GRID, { x: edge - 0.001, z: 0, heading: 0 })).toBe(true);
    expect(isWorldPosition(ISLAND_GRID, { x: edge, z: 0, heading: 0 })).toBe(false);
    expect(isWorldPosition(ISLAND_GRID, { x: -150, z: -150, heading: 0 })).toBe(true);
    expect(() => patchAtPosition(ISLAND_GRID, { x: edge, z: 0, heading: 0 })).toThrow('outside the world');
    expect(positionInPatch(CONGO_GRID, { x: 47_699, z: 0, heading: 0 }, 159)).toBe(true);
    expect(positionInPatch(ISLAND_GRID, { x: 0, z: 0, heading: 0 }, 400)).toBe(false);
  });

  it('places an animal deterministically inside its patch', () => {
    const p = initialPosition(CONGO_GRID, 'leopard_0001', 12_345);
    expect(positionInPatch(CONGO_GRID, p, 12_345)).toBe(true);
    expect(initialPosition(CONGO_GRID, 'leopard_0001', 12_345)).toEqual(p);
  });
});
