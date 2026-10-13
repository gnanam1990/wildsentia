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

  it('builds the 48 km congo_v1 grid from congo_terrain_v1', () => {
    const patches = buildGrid(7, 'congo_v1');
    expect(patches).toHaveLength(25_600);
    expect(patches.every((p, i) => p.id === i && p.congoSeed === 7 && p.islandSeed === undefined && p.surface === 'land')).toBe(true);
    expect(patches[0]!.neighbours).toEqual([1, 160]);
    expect(patches[161]!).toMatchObject({ x: 1, y: 1 });
    const river = patches.filter((p) => p.habitat === 'water');
    expect(river.length).toBeGreaterThan(0);
    expect(river.every((p) => p.waterVolume >= 300_000 && p.canopyCover === 0)).toBe(true);
    expect(patches.find((p) => p.habitat === 'bai')!.canopyCover).toBe(0.05);
    expect(patches.every((p) => p.elevation >= 0 && p.elevation <= 1)).toBe(true);
    expect(buildGrid(7, 'congo_v1')).toEqual(patches);
  }, 60_000);

  it('marks the main river\'s deep middle, which no land animal can walk (1B)', async () => {
    const { landWalkable } = await import('@vana/shared');
    const patches = buildGrid(7, 'congo_v1');
    const deep = patches.filter((p) => p.deepWater);
    expect(deep.length).toBeGreaterThan(100);
    expect(deep.every((p) => p.habitat === 'water' && p.neighbours.every((n) => patches[n]!.habitat === 'water'))).toBe(true);
    expect(deep.every((p) => !landWalkable(p))).toBe(true);
    // A river patch with dry ground beside it (a bank, or a narrow tributary) stays wadeable.
    const shallow = patches.filter((p) => p.habitat === 'water' && !p.deepWater);
    expect(shallow.length).toBeGreaterThan(0);
    expect(shallow.every((p) => landWalkable(p))).toBe(true);
  }, 60_000);
});
