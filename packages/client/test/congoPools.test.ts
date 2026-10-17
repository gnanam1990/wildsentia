import { afterEach, describe, expect, it } from 'vitest';
import { CONGO_GRID, ISLAND_GRID, congoChannelHalfM, congoRivers, patchCentre, riverIndex, waterAccessPosition } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { congoPool, drinkingPool, insidePool, onShore, waterGround } from '../src/pools.js';
import type { PatchView } from '../src/terrain.js';

afterEach(() => setWorldGrid(ISLAND_GRID));
const forest = (id: number, habitat = 'terra_firme', water = 1200): PatchView =>
  ({ id, x: id % 160, y: Math.floor(id / 160), habitat, elevation: 0.4, canopyCover: 0.9, grass: 800, browse: 4000, water, congoSeed: 7, surface: 'land' } as PatchView);

// A Congo animal drinks at its patch's water access point (a forest spring or stream pool); the
// view drew no water there, so a golden cat was seen "drinking" from dry leaf litter.
describe('the Congo forest pools', () => {
  it('draws a small pool at a forest patch\'s water access point, and a drinker on its edge', () => {
    setWorldGrid(CONGO_GRID);
    const patch = forest(30 * 160 + 30), pool = congoPool(patch)!;
    const access = waterAccessPosition(CONGO_GRID, patch.id);
    expect(pool).not.toBeNull();
    expect(Math.hypot(pool.x - access.x, pool.z - access.z)).toBeLessThan(0.01);
    expect(pool.radius).toBeGreaterThanOrEqual(2);
    expect(pool.radius).toBeLessThanOrEqual(12);
    expect(congoPool(forest(30 * 160 + 31, 'terra_firme', 10_000_000))!.radius).toBeLessThanOrEqual(12);
    // The animal the simulation puts at the access point is drawn at the water's edge, facing it.
    const drinker = onShore({ x: access.x, z: access.z, heading: 0, moving: false }, [pool], 0.4, true, 17);
    expect(insidePool(pool, drinker.x, drinker.z, 0.24)).toBe(false);
    expect(Math.hypot(drinker.x - pool.x, drinker.z - pool.z)).toBeLessThan(pool.radius * 1.4 + 1);
    expect(drinkingPool(patch)).toEqual(pool);
  });

  it('draws none for a dry patch, an island patch, or where the river itself is the water', () => {
    setWorldGrid(CONGO_GRID);
    expect(congoPool(forest(30 * 160 + 30, 'terra_firme', 0))).toBeNull();
    expect(congoPool({ ...forest(30 * 160 + 30), congoSeed: undefined } as PatchView)).toBeNull();
    // A river patch whose water access point lies in the channel drinks from the river ribbon.
    const near = riverIndex(congoRivers(7, CONGO_GRID));
    let checked = 0;
    for (let id = 0; id < 160 * 160 && checked < 40; id++) {
      const c = patchCentre(CONGO_GRID, id), a = near(c.x, c.z);
      if (a.distanceM > congoChannelHalfM(a.river, CONGO_GRID)) continue;
      const patch = forest(id, 'water', 80_000), ground = waterGround([patch]);
      const access = waterAccessPosition(CONGO_GRID, id, ground), at = near(access.x, access.z);
      const inChannel = at.distanceM <= congoChannelHalfM(at.river, CONGO_GRID);
      expect(congoPool(patch, ground) === null).toBe(inChannel);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});
