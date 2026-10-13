import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID, congoHeightFn } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { buildTerrain, makeHeightSampler, CONGO_BASE_M, type PatchView } from '../src/terrain.js';

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
});

describe('Congo trees (1A.4)', () => {
  it('keep four loaded regions within the island tree budget', () => {
    setWorldGrid(CONGO_GRID);
    const patches = [...region(4, 4), ...region(5, 4), ...region(4, 5), ...region(5, 5)];
    const trunks = buildTerrain(patches, new Set(['trunk'])).getObjectByName('trunk') as THREE.InstancedMesh;
    expect(trunks.count).toBeLessThanOrEqual(120_000);
    expect(trunks.count).toBeGreaterThan(30_000);
  });
});
