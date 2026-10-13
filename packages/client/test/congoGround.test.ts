import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID, congoHeightFn } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { terrainKeys } from '../src/terrainCheckpoints.js';
import { buildTerrain, congoLattice, congoWaterLevel, makeHeightSampler, CONGO_BASE_M, CONGO_STEP_M, type PatchView } from '../src/terrain.js';

afterEach(() => setWorldGrid(ISLAND_GRID));
const region = (rc: number, rr: number): PatchView[] => {
  const out: PatchView[] = [];
  for (let row = rr * 20; row < rr * 20 + 20; row++) for (let col = rc * 20; col < rc * 20 + 20; col++)
    out.push({ id: row * 160 + col, x: col, y: row, habitat: 'terra_firme', elevation: 0.4, canopyCover: 0.9, grass: 300, browse: 4000,
      water: 300, congoSeed: 7, surface: 'land' } as PatchView);
  return out;
};

describe('the Congo ground in the browser (1A.4)', () => {
  it('samples the same relief the simulation was built on', () => {
    setWorldGrid(CONGO_GRID);
    const sample = makeHeightSampler(region(4, 4)), h = congoHeightFn(7, CONGO_GRID);
    // At the 50 m lattice's vertices the drawn ground is the relief itself; between them, its triangles.
    for (const [x, z] of [[23_850 + 50 * 5, 23_850 + 50 * 9], [25_000 - 150 + 50, 26_000 - 150], [29_000 - 150, 28_500 - 150]]) expect(sample(x!, z!)).toBeCloseTo(h(x!, z!) - CONGO_BASE_M, 6);
  });
  it('draws ground only over the loaded regions, at a 50 m step, on that relief', () => {
    setWorldGrid(CONGO_GRID);
    const patches = [...region(4, 4), ...region(5, 4)];
    const ground = buildTerrain(patches, new Set(['ground'])).getObjectByName('ground') as THREE.Mesh;
    const box = new THREE.Box3().setFromBufferAttribute(ground.geometry.attributes.position as THREE.BufferAttribute);
    expect(box.min.x).toBeCloseTo(4 * 6000 - 150, 3); expect(box.max.x).toBeCloseTo(6 * 6000 - 150, 3);
    expect(box.min.z).toBeCloseTo(4 * 6000 - 150, 3); expect(box.max.z).toBeCloseTo(5 * 6000 - 150, 3);
    expect(ground.geometry.attributes.position!.count).toBe((240 + 1) * (120 + 1));
    const sample = makeHeightSampler(patches), p = ground.geometry.attributes.position!;
    expect(p.getY(1234)).toBeCloseTo(sample(p.getX(1234), p.getZ(1234)), 3); // a float32 mesh
  });
  it('draws no ground for the empty corner of an L of loaded regions', () => {
    setWorldGrid(CONGO_GRID);
    const ground = buildTerrain([...region(4, 4), ...region(5, 4), ...region(4, 5)], new Set(['ground'])).getObjectByName('ground') as THREE.Mesh;
    expect(ground.geometry.index!.count).toBe(3 * 120 * 120 * 6);
  });
  it('lays the soil texture by world position, one 3.2 m tile however many regions are loaded', () => {
    setWorldGrid(CONGO_GRID);
    const ground = buildTerrain(region(4, 4), new Set(['ground'])).getObjectByName('ground') as THREE.Mesh;
    const p = ground.geometry.attributes.position!, uv = ground.geometry.attributes.uv!;
    for (const i of [0, 777, p.count - 1]) {
      expect(uv.getX(i)).toBeCloseTo(p.getX(i) / 3.2, 2);
      expect(uv.getY(i)).toBeCloseTo(p.getZ(i) / 3.2, 2);
    }
  });
  it('keeps heights sampled past the east edge from overwriting the west edge', () => {
    setWorldGrid(CONGO_GRID);
    const lattice = congoLattice(11), h = congoHeightFn(11, CONGO_GRID), width = 48_000 / CONGO_STEP_M + 1;
    lattice.sample(48_000 + 25, 600); // a camera ray running past the forest's east edge
    // That sample reads columns 963-964 of rows 15-16; keyed row * 961 + column, column 963 of row 15 was vertex (2, 16).
    expect(lattice.vertex(2, 16)).toBeCloseTo(h(-150 + 2 * CONGO_STEP_M, -150 + 16 * CONGO_STEP_M) - CONGO_BASE_M, 5);
    expect(width).toBe(961);
  });
});

describe('Congo trees (1A.4)', () => {
  it('leave the island fallback trees out: the Congo forest layer draws its own (1A.5)', () => {
    setWorldGrid(CONGO_GRID);
    const patches = [...region(4, 4), ...region(5, 4), ...region(4, 5), ...region(5, 5)];
    const trunks = buildTerrain(patches, new Set(['trunk'])).getObjectByName('trunk') as THREE.InstancedMesh;
    expect(trunks.count).toBe(0);
  });
  it('stands flood water over the low part of a sloping patch, and a river 3.6 m over its lowest bed', () => {
    setWorldGrid(CONGO_GRID);
    const patch = { id: 94 * 160 + 96, x: 96, y: 94, habitat: 'flooded_forest', flooded: true } as PatchView;
    const cx = 96 * 300, cz = 94 * 300, samples: Array<[number, number]> = [];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) samples.push([cx + i * 70, cz + j * 70]);
    // Ground rising 20 m across the patch, its centre on the rise's middle but its low edge 10 m down.
    const slope = (x: number) => 80 + (x - cx) / 300 * 20;
    const flood = congoWaterLevel(patch, slope);
    const covered = samples.filter(([x]) => slope(x) < flood).length / samples.length;
    expect(covered).toBeGreaterThanOrEqual(0.4);
    expect(covered).toBeLessThan(1);
    // A channel 60 m wide at 70 m, banks at 80 m: the water stands 3.6 m over the bed, not over a bank.
    const channel = (x: number) => Math.abs(x - (cx + 100)) < 30 ? 70 : 80;
    expect(congoWaterLevel({ ...patch, habitat: 'water' }, channel)).toBeCloseTo(73.6, 5);
  });
  it('redraws the water when the flooded forest floods or drains', () => {
    setWorldGrid(CONGO_GRID);
    const patches = region(4, 4).map((p, i) => i === 5 ? { ...p, habitat: 'flooded_forest' } : p);
    const wet = patches.map((p, i) => i === 5 ? { ...p, flooded: true } : p);
    expect(terrainKeys(wet).water).not.toBe(terrainKeys(patches).water);
  });
});
