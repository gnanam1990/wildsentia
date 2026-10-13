import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID, congoChannelHalfM, congoRivers, patchCentre, riverIndex } from '@vana/shared';
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
    const floor = ground(deep.x, deep.z);
    forest.update(new THREE.Vector3(deep.x, 0, deep.z), new THREE.Vector3(deep.x, floor + 12, deep.z));
    expect(forest.canopyHole).toEqual({ x: deep.x, z: deep.z, radius: KIND_RADIUS_M.canopy - 40 });
    expect(forest.underCanopy).toBe(1); // the eye 12 m up, among the trunks
    // From above the canopy the forest is seen whole: no cut-away.
    forest.update(new THREE.Vector3(deep.x + 500, 0, deep.z), new THREE.Vector3(deep.x + 500, floor + 400, deep.z));
    expect(forest.canopyHole.radius).toBe(0);
    expect(forest.underCanopy).toBe(0);
  });
  it('draws the rivers, and the flood only in a flooding season', () => {
    setWorldGrid(CONGO_GRID);
    const forest = new CongoForest();
    forest.setScene([...region(3, 3), ...region(4, 3), ...region(3, 4), ...region(4, 4)], 7, true);
    expect(forest.root.getObjectByName('congo-water')).toBeDefined();
    forest.setScene([...region(3, 3)], 7, false);
    expect(forest.root.getObjectByName('flood')).toBeUndefined();
  });
  it('plants nothing while the eye looks down from above the canopy, and keeps a bounded memory of plans', () => {
    setWorldGrid(CONGO_GRID);
    const forest = new CongoForest(), patches = [...region(1, 1), ...region(2, 1)], floor = congoLattice(7).sample;
    forest.setScene(patches, 7, false);
    const at = (x: number, z: number, high: boolean) => forest.update(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, floor(x, z) + (high ? 900 : 10), z));
    expect(at(9000, 9000, true)).toBe(false);
    expect(forest.plannedPatches).toBe(0);
    for (let x = 6200; x < 17800; x += 400) at(x, 9000, false);
    expect(forest.plannedPatches).toBeLessThanOrEqual(96);
    expect(at(9000, 9000, true)).toBe(false);
    let shown = 0;
    forest.root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh && o.visible) shown++; });
    expect(shown).toBe(0);
  });
  it('opens the canopy over the river channel itself, and closes it over a river patch\'s dry edge', () => {
    setWorldGrid(CONGO_GRID);
    const rivers = congoRivers(7, CONGO_GRID), near = riverIndex(rivers), main = rivers[0]!, mid = main.points[Math.floor(main.points.length / 2)]!;
    const rc = Math.floor((mid.x + 150) / 6000), rr = Math.floor((mid.z + 150) / 6000), floor = congoLattice(7).sample;
    const patches = region(rc, rr, (id) => { const c = patchCentre(CONGO_GRID, id), a = near(c.x, c.z); return a.distanceM <= congoChannelHalfM(a.river, CONGO_GRID) ? 'water' : 'flooded_forest'; });
    const forest = new CongoForest();
    forest.setScene(patches, 7, false);
    const p = (forest.root.getObjectByName('canopy-shell') as THREE.Mesh).geometry.attributes.position!;
    let dryEdgeLifted = 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), a = near(x, z), half = congoChannelHalfM(a.river, CONGO_GRID), above = p.getY(i) - floor(x, z);
      if (a.distanceM <= half) expect(above).toBeLessThan(0.5);
      const id = Math.floor((z + 150) / 300) * 160 + Math.floor((x + 150) / 300);
      if (patches.find((q) => q.id === id)?.habitat === 'water' && a.distanceM > half + 60 && above > 10) dryEdgeLifted++;
    }
    expect(dryEdgeLifted).toBeGreaterThan(0);
  });
});
