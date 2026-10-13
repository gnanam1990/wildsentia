import { ISLAND_GRID, type WorldGrid } from '@vana/shared';

/**
 * The lattice of the world this page shows. A page shows exactly one world, so the grid the
 * server announces in its scene is kept here; until one arrives it is the island's.
 */
let current: WorldGrid = ISLAND_GRID;
export const worldGrid = (): WorldGrid => current;
export function setWorldGrid(grid: WorldGrid): void { current = grid; }

const fits = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= max;
/** At most 1,024 patches a side; anything else is not a world this client can draw. */
export function parseWorldGrid(value: unknown): WorldGrid {
  const g = value as Partial<WorldGrid> | undefined;
  return g && fits(g.cols, 1024) && fits(g.rows, 1024) && fits(g.patchM, 10_000) && fits(g.regionPatches, 1024)
    ? Object.freeze({ cols: g.cols, rows: g.rows, patchM: g.patchM, regionPatches: g.regionPatches }) : ISLAND_GRID;
}
