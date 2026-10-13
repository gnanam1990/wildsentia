import { describe, expect, it } from 'vitest';
import { ISLAND_GRID, CONGO_GRID } from '@vana/shared';
import { parseWorldGrid, setWorldGrid, worldGrid } from '../src/worldGrid.js';

describe('client world grid', () => {
  it('defaults to the island and adopts the grid a scene announces', () => {
    expect(worldGrid()).toEqual(ISLAND_GRID);
    setWorldGrid(parseWorldGrid({ cols: 160, rows: 160, patchM: 300, regionPatches: 20 }));
    expect(worldGrid()).toEqual(CONGO_GRID);
    setWorldGrid(ISLAND_GRID);
  });
  it('refuses a malformed grid and keeps the island', () => {
    expect(parseWorldGrid({ cols: -1, rows: 20, patchM: 300, regionPatches: 20 })).toEqual(ISLAND_GRID);
    expect(parseWorldGrid(undefined)).toEqual(ISLAND_GRID);
    expect(parseWorldGrid({ cols: 100_000, rows: 100_000, patchM: 300, regionPatches: 20 })).toEqual(ISLAND_GRID);
  });
});
