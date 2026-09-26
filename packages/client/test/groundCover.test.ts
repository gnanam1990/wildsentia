import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { COVER_RADIUS_M, CURVED_BLADE_RADIUS_M, DENSE_COVER_RADIUS_M, GroundCover, grassTuftGeometry, planGroundCover } from '../src/groundCover.js';
import { countDrawCalls, type PatchView } from '../src/terrain.js';
import { ObserverVisibility } from '../src/observerVisibility.js';
import { islandPool } from '../src/pools.js';

const patch: PatchView = { id: 0, x: 0, y: 0, habitat: 'grassland', grass: 6000, browse: 10, water: 200 };
const focus = { x: 0, z: 0 };
describe('dense ground cover', () => {
  it('leaves an island drinking pool clear of grass', () => {
    const island: PatchView = { ...patch, islandSeed: 1, surface: 'land', water: 400_000 };
    const pool = islandPool(island)!;
    expect(pool.radius).toBeGreaterThan(10);
    const tufts = planGroundCover([island], { x: pool.x, z: pool.z }, () => 0, 'high');
    expect(tufts.length).toBeGreaterThan(1000);
    expect(tufts.every((t) => Math.hypot(t.x - pool.x, t.z - pool.z) >= pool.radius)).toBe(true);
    expect(islandPool({ ...island, water: 0 })).toBeNull();
    expect(islandPool(patch)).toBeNull(); // Mainland planes keep their own water surfaces.
  });

  it('budgets even empty-cell scanning and commits the exact complete carpet, never a partial buffer', () => {
    for (const patches of [[patch], [{ ...patch, grass: 0 }]]) {
      const cover = new GroundCover(patches, (x, z) => x * .2 + z * .1);
      const reference = new GroundCover(patches, (x, z) => x * .2 + z * .1);
      reference.update(focus);
      expect(cover.update(focus, 0)).toBe(false);
      expect(cover.preparing).toBe(true);
      const meshes = cover.root.children as THREE.InstancedMesh[];
      expect(meshes.every((mesh) => mesh.count === 0 && mesh.instanceMatrix.version === 0)).toBe(true);
      let calls = 1;
      while (cover.preparing && calls++ < 500) cover.update(focus, 0);
      expect(calls).toBeGreaterThan(100); expect(calls).toBeLessThan(500);
      expect(cover.preparing).toBe(false);
      meshes.forEach((mesh, i) => {
        const expected = reference.root.children[i] as THREE.InstancedMesh;
        expect(mesh.count).toBe(expected.count);
        expect(mesh.instanceMatrix.array).toEqual(expected.instanceMatrix.array);
        expect(mesh.instanceColor!.array).toEqual(expected.instanceColor!.array);
      });
      cover.dispose(); reference.dispose();
    }
  });
  it('retains the complete previous carpet while moving, without continually restarting preparation', () => {
    const cover = new GroundCover([patch], () => 0); cover.setQuality('smooth'); cover.update(focus);
    const meshes = cover.root.children as THREE.InstancedMesh[];
    const before = meshes.map((mesh) => ({ count: mesh.count, version: mesh.instanceMatrix.version, data: mesh.instanceMatrix.array.slice() }));
    expect(cover.update({ x: 11, z: 0 }, 0)).toBe(false);
    for (let i = 0; i < 20; i++) cover.update({ x: 11 + i * .1, z: 0 }, 0);
    meshes.forEach((mesh, i) => {
      expect(mesh.count).toBe(before[i]!.count); expect(mesh.instanceMatrix.version).toBe(before[i]!.version);
      expect(mesh.instanceMatrix.array).toEqual(before[i]!.data);
    });
    expect(cover.update({ x: 13, z: 0 })).toBe(true); // finishes x=11, not a stale partial x=13
    expect(cover.update({ x: 13, z: 0 })).toBe(false);
    cover.dispose();
  });
  it('cancels superseded quality, patch, teleport and disposed work', () => {
    const cover = new GroundCover([patch], () => 0);
    cover.update(focus, 0); cover.setQuality('smooth');
    expect(cover.preparing).toBe(false); cover.update(focus);
    const meshes = cover.root.children as THREE.InstancedMesh[];
    expect(meshes.reduce((n, mesh) => n + mesh.count, 0)).toBe(planGroundCover([patch], focus, () => 0, 'smooth').length);
    cover.update({ x: 15, z: 0 }, 0);
    cover.setPatches([{ ...patch, water: 30_000 }]);
    expect(cover.preparing).toBe(false); expect(meshes.every((mesh) => mesh.count === 0)).toBe(true);
    cover.update(focus); expect(meshes.every((mesh) => mesh.count === 0)).toBe(true);
    cover.setPatches([patch]); cover.update(focus, 0);
    cover.update({ x: 6000, z: 6000 }); // superseded focus must not publish origin grass
    expect(meshes.every((mesh) => mesh.count === 0)).toBe(true);
    cover.update(focus, 0); cover.dispose();
    expect(cover.preparing).toBe(false); expect(cover.update(focus)).toBe(false);
  });
  it('queues only active instance prefixes and preserves unconsumed larger writes', () => {
    const cover = new GroundCover([patch], () => 0); cover.update(focus);
    const meshes = cover.root.children as THREE.InstancedMesh[];
    const old = meshes.map((mesh) => mesh.count);
    cover.setQuality('smooth'); cover.update(focus);
    meshes.forEach((mesh, i) => {
      expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: Math.max(old[i]!, mesh.count) * 16 }]);
      mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceColor!.clearUpdateRanges();
    });
    cover.update({ x: 11, z: 0 });
    meshes.forEach((mesh) => {
      expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: mesh.count * 16 }]);
      expect(mesh.instanceColor!.updateRanges).toEqual([{ start: 0, count: mesh.count * 3 }]);
      expect(mesh.count).toBeLessThan(mesh.instanceMatrix.count / 3);
    });
    cover.dispose();
  });
  it('reduces actual instance triangle work while retaining foreground grass and stable plants', () => {
    const full = planGroundCover([patch], focus, () => 0, 'high');
    const positions = new Set(full.map((p) => `${p.x}:${p.z}`));
    const cover = new GroundCover([patch], () => 0);
    const counts: number[] = [];
    for (const tier of ['high', 'balanced', 'smooth'] as const) {
      cover.setQuality(tier); cover.update(focus);
      const plan = planGroundCover([patch], focus, () => 0, tier);
      expect(plan.filter((p) => Math.hypot(p.x, p.z) <= 18)).toEqual(full.filter((p) => Math.hypot(p.x, p.z) <= 18));
      expect(plan.every((p) => positions.has(`${p.x}:${p.z}`))).toBe(true);
      const triangles = (cover.root.children as THREE.InstancedMesh[]).reduce((n, mesh) => n + mesh.count * mesh.geometry.index!.count / 3, 0);
      counts.push(triangles);
      expect(plan.some((p) => Math.hypot(p.x, p.z) > 130)).toBe(true);
      expect(cover.update(focus)).toBe(false);
    }
    expect(counts[1]!).toBeLessThan(counts[0]! * 0.35);
    expect(counts[2]!).toBeLessThan(counts[0]! * 0.2);
    cover.dispose();
  });
  it('provides a bounded carpet, not a few scattered clumps', () => {
    const plan = planGroundCover([patch], focus, () => 5);
    expect(plan.length).toBeGreaterThan(35_000);
    expect(plan.length).toBeLessThan(70_000);
    expect(plan.filter((p) => Math.hypot(p.x, p.z) > DENSE_COVER_RADIUS_M).length).toBeGreaterThan(8_000);
    for (const p of plan) {
      expect(Math.hypot(p.x, p.z)).toBeLessThan(COVER_RADIUS_M);
      expect(p.y).toBe(5); expect(p.height).toBeGreaterThan(0); expect(p.height).toBeLessThan(0.7);
    }
  });
  it('keeps a thicker shola floor near the observer without inventing grass on bare ground', () => {
    const woodland = { ...patch, habitat: 'shola' as const, grass: 1000 };
    const near = (tier: 'smooth' | 'balanced' | 'high') =>
      planGroundCover([woodland], focus, () => 0, tier).filter(p => Math.hypot(p.x, p.z) < 18);
    expect(near('balanced')).toEqual(near('high'));
    expect(near('smooth')).toEqual(near('high'));
    expect(near('balanced').length).toBeGreaterThan(900);
    expect(planGroundCover([{ ...woodland, grass: 0 }], focus, () => 0, 'balanced')).toEqual([]);
  });
  it('keeps plant positions fixed as the camera moves and conforms to slopes', () => {
    const before = planGroundCover([patch], focus, (x, z) => x * 0.2 + z * 0.1);
    const after = planGroundCover([patch], { x: 5, z: 5 }, (x, z) => x * 0.2 + z * 0.1);
    const positions = new Set(after.map((p) => `${p.x}:${p.z}`));
    const interior = before.filter((p) => Math.hypot(p.x, p.z) < 40);
    expect(interior.every((p) => positions.has(`${p.x}:${p.z}`))).toBe(true);
    expect(before.every((p) => p.y === p.x * 0.2 + p.z * 0.1)).toBe(true);
  });
  it('does not paint grass onto bare or flooded ground and thins with biomass', () => {
    for (const changes of [{ grass: 0 }, { water: 30_000 }, { habitat: 'water' }]) {
      expect(planGroundCover([{ ...patch, ...changes }], focus, () => 0)).toEqual([]);
    }
    expect(planGroundCover([{ ...patch, grass: 60 }], focus, () => 0).length)
      .toBeLessThan(planGroundCover([patch], focus, () => 0).length / 4);
  });
  it('uses curved close blades and lighter far blades in two draws, without per-frame rebuilding', () => {
    const geometry = grassTuftGeometry();
    expect(geometry.index!.count / 3).toBe(84);
    const distant = grassTuftGeometry(2);
    expect(distant.index!.count / 3).toBe(36);
    const cover = new GroundCover([patch], () => 0);
    expect(cover.update(focus)).toBe(true);
    expect(cover.update({ x: 1, z: 1 })).toBe(false);
    expect(countDrawCalls(cover.root)).toBe(2);
    const meshes = cover.root.children as THREE.InstancedMesh[];
    expect(meshes.reduce((sum, mesh) => sum + mesh.instanceMatrix.count, 0)).toBeLessThan(110_000);
    expect(meshes.reduce((sum, mesh) => sum + mesh.count, 0)).toBe(planGroundCover([patch], focus, () => 0).length);
    const matrix = new THREE.Matrix4();
    meshes.forEach((mesh, level) => {
      expect(mesh.count).toBeLessThan(mesh.instanceMatrix.count);
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        const distance = Math.hypot(matrix.elements[12]!, matrix.elements[14]!);
        if (level === 0) expect(distance).toBeLessThan(CURVED_BLADE_RADIUS_M + 0.001);
        else expect(distance).toBeGreaterThan(CURVED_BLADE_RADIUS_M - 0.001);
      }
    });
    cover.animate(3, true);
    cover.setPatches([{ ...patch, grass: 0 }]);
    expect(cover.update(focus)).toBe(true);
    expect(meshes.every((mesh) => mesh.count === 0)).toBe(true);
    geometry.dispose(); distant.dispose(); cover.dispose();
  });
  it('samples identical roots, tips and centre curves at both detail levels', () => {
    const near = grassTuftGeometry(4), far = grassTuftGeometry(2);
    const a = near.getAttribute('position'), b = far.getAttribute('position');
    for (let blade = 0; blade < 12; blade++) {
      // Far geometry samples t=0,.5,1; detailed geometry adds .25 and .75 only.
      for (const [fine, coarse] of [[0, 0], [1, 1], [4, 2], [5, 3], [8, 4]]) {
        const i = blade * 9 + fine!, j = blade * 5 + coarse!;
        expect([a.getX(i), a.getY(i), a.getZ(i)]).toEqual([b.getX(j), b.getY(j), b.getZ(j)]);
      }
    }
    for (const geo of [near, far]) {
      expect(Array.from(geo.getAttribute('normal').array).every(Number.isFinite)).toBe(true);
      const color = geo.getAttribute('color');
      // Authored green is linearized, not the old bright linear 0.68 green channel.
      expect(Math.max(...Array.from(color.array))).toBeLessThan(0.4);
      const index = geo.index!;
      const p = geo.getAttribute('position');
      for (let t = 0; t < index.count; t += 3) {
        const u = new THREE.Vector3().fromBufferAttribute(p, index.getX(t));
        const v = new THREE.Vector3().fromBufferAttribute(p, index.getX(t + 1));
        const w = new THREE.Vector3().fromBufferAttribute(p, index.getX(t + 2));
        expect(v.sub(u).cross(w.sub(u)).length()).toBeGreaterThan(0);
      }
      geo.dispose();
    }
  });
  it('keeps both blade levels on one wind material and releases owned GPU resources once', () => {
    const cover = new GroundCover([patch], () => 0);
    const meshes = [...cover.root.children] as THREE.InstancedMesh[];
    expect(meshes[0]!.material).toBe(meshes[1]!.material);
    const material = meshes[0]!.material as THREE.Material;
    new ObserverVisibility().attach(cover.root);
    const shader = { uniforms: {} as Record<string, { value: number }>, vertexShader: '#include <begin_vertex>',
      fragmentShader: '#include <alphatest_fragment>' };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('coverMotion');
    expect(shader.fragmentShader).toContain('gl_FragCoord.z < subject.w');
    cover.animate(12, true);
    expect(shader.uniforms.coverMotion!.value).toBe(0);
    cover.animate(13, false);
    expect(shader.uniforms.coverMotion!.value).toBe(1);
    expect(shader.uniforms.coverTime!.value).toBe(13);
    const materialDisposed = vi.fn(); material.addEventListener('dispose', materialDisposed);
    const geometryDisposed = meshes.map((mesh) => {
      const callback = vi.fn(); mesh.geometry.addEventListener('dispose', callback); return callback;
    });
    cover.dispose(); cover.dispose();
    expect(materialDisposed).toHaveBeenCalledTimes(1);
    for (const callback of geometryDisposed) expect(callback).toHaveBeenCalledTimes(1);
    expect(cover.root.children).toHaveLength(0); expect(cover.update(focus)).toBe(false);
  });
  it('keeps the coarse outer plants world-anchored and fills the detail transition', () => {
    const before = planGroundCover([patch], focus, () => 0);
    const after = planGroundCover([patch], { x: 5, z: 5 }, () => 0);
    const positions = new Set(after.map((p) => `${p.x}:${p.z}`));
    const outer = before.filter((p) => Math.hypot(p.x, p.z) > 80 && Math.hypot(p.x, p.z) < 115);
    expect(outer.length).toBeGreaterThan(1000);
    expect(outer.every((p) => positions.has(`${p.x}:${p.z}`))).toBe(true);
    for (const radius of [50, 60, 70, 100, 130]) {
      expect(before.filter((p) => Math.abs(Math.hypot(p.x, p.z) - radius) < 3).length).toBeGreaterThan(200);
    }
  });
  it('does not render costly grass blades from a high overview and restores close cover', () => {
    const cover = new GroundCover([patch], () => 20);
    cover.update({ x: 0, y: 21, z: 0 });
    const count = (cover.root.children[0] as import('three').InstancedMesh).count;
    expect(count).toBeGreaterThan(0);
    cover.update({ x: 0, y: 300, z: 0 }); expect(cover.root.visible).toBe(false);
    cover.update({ x: 0, y: 25, z: 0 }); expect(cover.root.visible).toBe(true);
    expect((cover.root.children[0] as import('three').InstancedMesh).count).toBe(count);
  });
});
