import { describe, expect, it } from 'vitest';

import { buildGrid } from '../src/grid.js';
import { ISLAND_GRID, patchCount } from '@vana/shared';

describe('buildGrid', () => {
  it('produces one patch per grid cell, indexed by id', () => {
    const grid = buildGrid(1);
    expect(grid).toHaveLength(patchCount(ISLAND_GRID));
    grid.forEach((p, i) => expect(p.id).toBe(i));
  });

  it('is deterministic for a given seed', () => {
    expect(buildGrid(99)).toEqual(buildGrid(99));
  });

  it('links neighbours symmetrically', () => {
    const grid = buildGrid(3);
    for (const p of grid) {
      for (const n of p.neighbours) expect(grid[n]!.neighbours).toContain(p.id);
    }
  });

  it('gives interior patches four neighbours and corners two', () => {
    const grid = buildGrid(3);
    expect(grid.find((p) => p.x === 5 && p.y === 5)!.neighbours).toHaveLength(4);
    expect(grid.find((p) => p.x === 0 && p.y === 0)!.neighbours).toHaveLength(2);
  });

  it('starts every patch with non-negative fields and some water', () => {
    const grid = buildGrid(5);
    for (const p of grid) {
      expect(p.plant.grass).toBeGreaterThanOrEqual(0);
      expect(p.capacity.grass).toBeGreaterThanOrEqual(0);
      expect(p.soilNutrients).toBeGreaterThanOrEqual(0);
      expect(p.waterVolume).toBeGreaterThanOrEqual(0);
    }
    expect(grid.some((p) => p.habitat === 'water')).toBe(true);
    expect(grid.some((p) => p.habitat === 'grassland')).toBe(true);
  });
});
