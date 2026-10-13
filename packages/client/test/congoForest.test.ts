import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID, patchCentre } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { congoLattice, type PatchView } from '../src/terrain.js';
import { CANOPY_HEIGHT_M, CongoForest, KIND_RADIUS_M } from '../src/congoForest.js';

afterEach(() => setWorldGrid(ISLAND_GRID));
const region = (rc: number, rr: number, habitatOf: (id: number) => string = () => 'terra_firme'): PatchView[] => {
  const out: PatchView[] = [];
  for (let row = rr * 20; row < rr * 20 + 20; row++) for (let col = rc * 20; col < rc * 20 + 20; col++) {
    const id = row * 160 + col;
    out.push({ id, x: col, y: row, habitat: habitatOf(id), elevation: 0.4, canopyCover: 0.9, grass: 800, browse: 4000, water: 300, congoSeed: 7, surface: 'land' } as PatchView);
  }
  return out;
};
const instances = (forest: CongoForest) => {
  const out = new Map<string, THREE.Vector3[]>();
  forest.root.traverse((o) => {
    const mesh = o as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh || !mesh.name.startsWith('congo:')) return;
    const kind = mesh.name.split(':')[1]!, m = new THREE.Matrix4(), list = out.get(kind) ?? [];
    for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m); list.push(new THREE.Vector3().setFromMatrixPosition(m)); }
    out.set(kind, list);
  });
  return out;
};

// Congo 1A.5: plants stand near the camera; beyond them a canopy surface covers the forest.
describe('the Congo forest layer', () => {
  it('stands each kind of plant only within its distance of the camera, on the ground', () => {
    setWorldGrid(CONGO_GRID);
    const forest = new CongoForest(), patches = region(1, 1);
    forest.setScene(patches, 7, false);
    const focus = new THREE.Vector3(patchCentre(CONGO_GRID, 30 * 160 + 30).x, 0, patchCentre(CONGO_GRID, 30 * 160 + 30).z);
    expect(forest.update(focus)).toBe(true);
    const placed = instances(forest), ground = congoLattice(7).sample;
    for (const kind of ['emergent', 'canopy', 'midstory', 'sapling', 'marantaceae']) {
      const list = placed.get(kind) ?? [];
      expect(list.length, kind).toBeGreaterThan(0);
      for (const p of list) {
        expect(Math.hypot(p.x - focus.x, p.z - focus.z)).toBeLessThanOrEqual(KIND_RADIUS_M[kind as keyof typeof KIND_RADIUS_M] + 1);
        expect(p.y).toBeLessThanOrEqual(ground(p.x, p.z) + 0.01);
        expect(p.y).toBeGreaterThan(ground(p.x, p.z) - 1);
      }
    }
    expect(forest.update(focus.clone().add(new THREE.Vector3(30, 0, 0)))).toBe(false);
    expect(forest.update(focus.clone().add(new THREE.Vector3(90, 0, 0)))).toBe(true);
  });
  it('covers forest with a canopy surface at its height, opens over a bai, and leaves a hole where the plants stand', () => {
    setWorldGrid(CONGO_GRID);
    const baiId = 25 * 160 + 25, forest = new CongoForest();
    forest.setScene(region(1, 1, (id) => id === baiId ? 'bai' : 'terra_firme'), 7, false);
    const shell = forest.root.getObjectByName('canopy-shell') as THREE.Mesh, p = shell.geometry.attributes.position!, ground = congoLattice(7).sample;
    const bai = patchCentre(CONGO_GRID, baiId), deep = patchCentre(CONGO_GRID, 32 * 160 + 32);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), above = p.getY(i) - ground(x, z);
      if (Math.abs(x - bai.x) < 100 && Math.abs(z - bai.z) < 100) expect(above).toBeLessThan(0.5);
      if (Math.abs(x - deep.x) < 100 && Math.abs(z - deep.z) < 100) expect(Math.abs(above - CANOPY_HEIGHT_M.terra_firme)).toBeLessThanOrEqual(5);
    }
    forest.update(new THREE.Vector3(deep.x, 0, deep.z));
    expect(forest.canopyHole).toEqual({ x: deep.x, z: deep.z, radius: KIND_RADIUS_M.canopy - 40 });
  });
  it('draws the rivers, and the flood only in a flooding season', () => {
    setWorldGrid(CONGO_GRID);
    const forest = new CongoForest();
    forest.setScene([...region(3, 3), ...region(4, 3), ...region(3, 4), ...region(4, 4)], 7, true);
    expect(forest.root.getObjectByName('congo-water')).toBeDefined();
    forest.setScene([...region(3, 3)], 7, false);
    expect(forest.root.getObjectByName('flood')).toBeUndefined();
  });
});
