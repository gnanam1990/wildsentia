import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID, congoChannelHalfM, congoRivers, riverIndex } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { CONGO_BASE_M, congoLattice } from '../src/terrain.js';
import { buildCongoWater } from '../src/congoWater.js';

afterEach(() => setWorldGrid(ISLAND_GRID));
const bounds = (c0: number, r0: number, c1: number, r1: number) => ({ minX: c0 * 6000 - 150, minZ: r0 * 6000 - 150, maxX: (c1 + 1) * 6000 - 150, maxZ: (r1 + 1) * 6000 - 150 });

// Congo 1A.5: rivers run as their channels run, not in 300 m squares; the flood follows the banks.
describe('Congo rivers and flood', () => {
  it('draws each river as a smooth ribbon at its own level, as wide as its channel, within the loaded ground', () => {
    setWorldGrid(CONGO_GRID);
    const rivers = congoRivers(7, CONGO_GRID), main = rivers[0]!;
    const mid = main.points[Math.floor(main.points.length / 2)]!;
    const c = Math.floor((mid.x + 150) / 6000), r = Math.floor((mid.z + 150) / 6000), box = bounds(c - 1, r - 1, c + 1, r + 1);
    const group = buildCongoWater(7, box, false);
    const ribbon = group.getObjectByName('river:0') as THREE.Mesh;
    const p = ribbon.geometry.attributes.position!;
    expect(p.count).toBeGreaterThan(8);
    const half = congoChannelHalfM(main, CONGO_GRID), near = riverIndex([main]), reach = 1500 + half + 21;
    for (let i = 0; i < p.count; i++) {
      expect(p.getX(i)).toBeGreaterThanOrEqual(box.minX - reach); expect(p.getX(i)).toBeLessThanOrEqual(box.maxX + reach);
      // Every edge vertex lies at the channel's edge (plus its 20 m tuck under the bank), at the river's level.
      const at = near(p.getX(i), p.getZ(i));
      expect(at.distanceM).toBeLessThanOrEqual(half + 21);
      expect(p.getY(i)).toBeCloseTo(at.levelM - 0.4 - CONGO_BASE_M, 0);
    }
    expect(group.getObjectByName('flood')).toBeUndefined();
  });
  it('stands flood water just over the flooded forest belt in the rains, and nowhere in the dry', () => {
    setWorldGrid(CONGO_GRID);
    const rivers = congoRivers(7, CONGO_GRID), main = rivers[0]!, near = riverIndex(rivers);
    const mid = main.points[Math.floor(main.points.length / 2)]!;
    const c = Math.floor((mid.x + 150) / 6000), r = Math.floor((mid.z + 150) / 6000);
    const flood = buildCongoWater(7, bounds(c, r, c, r), true).getObjectByName('flood') as THREE.Mesh;
    const p = flood.geometry.attributes.position!, index = flood.geometry.index!, lattice = congoLattice(7);
    expect(index.count).toBeGreaterThan(0);
    for (let k = 0; k < index.count; k += 97) {
      const i = index.getX(k);
      expect(p.getY(i)).toBeCloseTo(lattice.sample(p.getX(i), p.getZ(i)) + 0.6, 3);
      const at = near(p.getX(i), p.getZ(i));
      expect(at.distanceM).toBeLessThanOrEqual(congoChannelHalfM(at.river, CONGO_GRID) + at.river.floodBeltM + 50);
    }
  });
});
