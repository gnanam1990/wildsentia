import { describe, expect, it } from 'vitest';
import { CONGO_GRID, ISLAND_GRID, landRayDistance, patchCentre, type Patch } from '../src/index.js';

// Congo 1B: a chase stops at the great river's deep middle, as an island chase stops at the sea.
describe('the ground a chase may cross', () => {
  it('ends at deep water on the Congo grid', () => {
    const patches: Patch[] = Array.from({ length: CONGO_GRID.cols * CONGO_GRID.rows }, (_, id) => ({
      id, x: id % 160, y: Math.floor(id / 160), surface: 'land', habitat: 'terra_firme', deepWater: id % 160 >= 12 ? true : undefined,
    } as unknown as Patch));
    const start = patchCentre(CONGO_GRID, 160 * 50 + 10);
    const east = landRayDistance(CONGO_GRID, patches, { ...start, heading: 0 }, Math.PI / 2);
    expect(east).toBeGreaterThan(0); expect(east).toBeLessThan(2 * 300); // the deep river begins two patches east
    expect(landRayDistance(CONGO_GRID, patches, { ...start, heading: 0 }, -Math.PI / 2)).toBeGreaterThan(2_000); // west is all land
  });
  it('is unchanged on the island grid', () => {
    const patches: Patch[] = Array.from({ length: 400 }, (_, id) => ({ id, x: id % 20, y: Math.floor(id / 20), surface: id % 20 >= 15 ? 'ocean' : 'land' } as unknown as Patch));
    expect(landRayDistance(ISLAND_GRID, patches, { x: 0, z: 0, heading: 0 }, Math.PI / 2)).toBeCloseTo(4_350 - 0.01, 6);
  });
});
