import { describe, expect, it } from 'vitest';
import { patchCentre, type Patch, type WorldGrid } from '@vana/shared';
import { landRoute } from '../src/live/route.js';

// A 12 x 12 grid of land with a wall of deep water down column 6, open only at row 10.
const GRID: WorldGrid = { cols: 12, rows: 12, patchM: 300, regionPatches: 12 };
const world = (closed: boolean): Patch[] => Array.from({ length: 144 }, (_, id) => {
  const x = id % 12, y = Math.floor(id / 12);
  const wall = x === 6 && (closed || y !== 10);
  return { id, x, y, surface: 'land', habitat: y < 3 ? 'marsh' : 'grassland', ...(wall ? { deepWater: true } : {}) } as unknown as Patch;
});
const at = (x: number, y: number) => patchCentre(GRID, y * 12 + x);

describe("landRoute on a drawn grid", () => {
  it('goes round the water through the one gap, past costly ground', () => {
    const route = landRoute(GRID, world(false), at(1, 1), at(10, 1), (h) => (h === 'marsh' ? 4 : 1))!;
    expect(route).not.toBeNull();
    // Every leg ends on land, and the walk passes the gap at row 10.
    expect(route.points.at(-1)).toEqual(at(10, 1));
    expect(route.points.some((p) => Math.abs(p.z - at(6, 10).z) < 300 && Math.abs(p.x - at(6, 10).x) <= 300)).toBe(true);
    expect(route.metres).toBeGreaterThan(2 * 9 * 300);
  });

  it('refuses a goal no land path reaches, having searched every reachable patch', () => {
    expect(landRoute(GRID, world(true), at(1, 1), at(10, 1), () => 1)).toBeNull();
  });
});
