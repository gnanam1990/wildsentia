import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID, congoChannelHalfM, congoRivers, riverIndex } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { CONGO_BASE_M, congoLattice } from '../src/terrain.js';
import { buildCongoWater, type LoadedGround } from '../src/congoWater.js';

afterEach(() => setWorldGrid(ISLAND_GRID));
const bounds = (c0: number, r0: number, c1: number, r1: number): LoadedGround => {
  const regions = new Set<string>();
  for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) regions.add(`${c},${r}`);
  return { minX: c0 * 6000 - 150, minZ: r0 * 6000 - 150, maxX: (c1 + 1) * 6000 - 150, maxZ: (r1 + 1) * 6000 - 150, regions };
};

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
    // The channel is the river's: every flood cell's centre lies outside it, so the flood never overlaps its ribbon.
    for (let k = 0; k < index.count; k += 6) {
      const a = index.getX(k), d = index.getX(k + 4);
      const at = near((p.getX(a) + p.getX(d)) / 2, (p.getZ(a) + p.getZ(d)) / 2);
      expect(at.distanceM).toBeGreaterThan(congoChannelHalfM(at.river, CONGO_GRID));
    }
    for (let k = 0; k < index.count; k += 97) {
      const i = index.getX(k);
      // 0.6 m deep inside the belt; at its shore a corner sinks under the ground, so the edge follows the slope.
      const over = p.getY(i) - lattice.sample(p.getX(i), p.getZ(i));
      expect([0.6, -0.4].some((d) => Math.abs(over - d) < 1e-3)).toBe(true);
      const at = near(p.getX(i), p.getZ(i));
      // Within a flood belt (near a confluence the nearest river may be another's: take the widest).
      expect(at.distanceM).toBeLessThanOrEqual(Math.max(...congoRivers(7, CONGO_GRID).map((r) => congoChannelHalfM(r, CONGO_GRID) + r.floodBeltM)) + 50);
    }
  });
  it('draws the main river over its tributaries and both over the flood, whatever the camera does', () => {
    setWorldGrid(CONGO_GRID);
    const group = buildCongoWater(7, bounds(0, 0, 7, 7), false), rivers = congoRivers(7, CONGO_GRID), m = rivers[0]!.points[Math.floor(rivers[0]!.points.length / 2)]!;
    const flood = buildCongoWater(7, bounds(Math.floor((m.x + 150) / 6000), Math.floor((m.z + 150) / 6000), Math.floor((m.x + 150) / 6000), Math.floor((m.z + 150) / 6000)), true).getObjectByName('flood')!;
    const main = group.getObjectByName('river:0')!;
    for (let i = 1; i < rivers.length; i++) {
      const t = group.getObjectByName(`river:${i}`);
      if (t) { expect(t.renderOrder).toBeGreaterThan(flood.renderOrder); expect(main.renderOrder).toBeGreaterThan(t.renderOrder); }
    }
  });
  it('draws water only over loaded ground, not over the empty corner of an L of regions', () => {
    setWorldGrid(CONGO_GRID);
    const main = congoRivers(7, CONGO_GRID)[0]!, mid = main.points[Math.floor(main.points.length / 2)]!;
    const c = Math.floor((mid.x + 150) / 6000), r = Math.floor((mid.z + 150) / 6000);
    const box = bounds(c, r, c + 1, r + 1);
    box.regions.delete(`${c + 1},${r + 1}`);
    const group = buildCongoWater(7, box, true), inside = (x: number, z: number) => box.regions.has(`${Math.floor((x + 150) / 6000)},${Math.floor((z + 150) / 6000)}`);
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const p = mesh.geometry.attributes.position!, index = mesh.geometry.index!;
      for (let k = 0; k < index.count; k += 3) {
        const [a, b, d] = [index.getX(k), index.getX(k + 1), index.getX(k + 2)];
        const x = (p.getX(a) + p.getX(b) + p.getX(d)) / 3, z = (p.getZ(a) + p.getZ(b) + p.getZ(d)) / 3;
        // A triangle's middle lies over loaded ground, or within a ribbon's width of it.
        if (!inside(x, z)) expect([[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => inside(x + dx! * 700, z + dz! * 700))).toBe(true);
      }
    });
  });
});
