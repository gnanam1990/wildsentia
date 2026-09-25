import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ForestBatches, type ForestPlacement } from '../src/forestBatches.js';
import { ObserverVisibility } from '../src/observerVisibility.js';

const atlas = () => ({ target: new THREE.WebGLRenderTarget(1, 1), centre: new THREE.Vector3(3, 8, -2), diameter: 25 });
const plant = (x: number, z: number, scale = 2): ForestPlacement => ({ x, y: 50 + x / 100, z, scale, rotY: x / 10 });
const meshes = (forest: ForestBatches) => forest.root.children.filter((m) => (m as THREE.InstancedMesh).count > 0) as THREE.InstancedMesh[];

describe('spatial forest batches', () => {
  it('preserves every placement and Float32 transform without camera-driven uploads', () => {
    const source = atlas(), forest = new ForestBatches(source, 'test');
    const items = [plant(-700, -600), plant(-600, -600), plant(0, 0), plant(599, 599), plant(600, 600)];
    forest.setItems(items);
    const actual: number[][] = [], expected: number[][] = [];
    const matrix = new THREE.Matrix4();
    for (const mesh of meshes(forest)) {
      expect(mesh.frustumCulled).toBe(true); expect(mesh.castShadow).toBe(false);
      for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, matrix); actual.push(matrix.elements.slice()); }
    }
    for (const item of items) {
      matrix.compose(new THREE.Vector3(item.x, item.y, item.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), item.rotY), new THREE.Vector3().setScalar(item.scale));
      expected.push(Array.from(new Float32Array(matrix.elements)));
    }
    expect(actual.map((m) => JSON.stringify(m)).sort()).toEqual(expected.map((m) => JSON.stringify(m)).sort());
    const versions = meshes(forest).map((m) => m.instanceMatrix.version);
    for (const focus of [{ x: 0, z: 0 }, { x: 9000, z: 9000 }, { x: -400, z: 800 }]) forest.updateRange(focus);
    forest.setItems([...items]); // new aggregate, same immutable placements
    expect(meshes(forest).map((m) => m.instanceMatrix.version)).toEqual(versions);
    forest.dispose(); source.target.dispose();
  });

  it('bounds the actual shader billboard for all camera orientations, not just the source plane', () => {
    const source = atlas(), forest = new ForestBatches(source, 'test');
    forest.setItems([plant(-10, 50, .5), plant(599.999, 0, 4), plant(700, -20, 3)]);
    const matrix = new THREE.Matrix4(), centre = new THREE.Vector3();
    for (const mesh of meshes(forest)) for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix); centre.copy(source.centre).applyMatrix4(matrix);
      const size = source.diameter * Math.hypot(...matrix.elements.slice(0, 3)) / 2;
      for (let yaw = 0; yaw < 12; yaw++) for (let pitch = 0; pitch < 5; pitch++) {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * Math.PI / 8, yaw * Math.PI / 6, 0));
        for (const x of [-1, 1]) for (const y of [-1, 1]) {
          const point = new THREE.Vector3(x * size, y * size, 0).applyQuaternion(q).add(centre);
          expect(mesh.boundingBox!.containsPoint(point)).toBe(true);
          expect(mesh.boundingSphere!.containsPoint(point)).toBe(true);
        }
      }
    }
    forest.dispose(); source.target.dispose();
  });

  it('culls offscreen regions, restores them on orbit/teleport, and retains boundary crowns', () => {
    const source = atlas(), forest = new ForestBatches(source, 'test');
    forest.setItems([plant(0, 1200), plant(0, -1200), plant(2810, 0, 4)]);
    forest.updateRange({ x: 0, z: 0 }); forest.root.updateMatrixWorld(true);
    // Root is beyond 2800 m, but a large crown can still be visible at the horizon.
    expect(meshes(forest).every((m) => m.visible)).toBe(true);
    const camera = new THREE.PerspectiveCamera(50, 1, .3, 4000); camera.position.set(0, 50, 0);
    const submitted = (z: number) => {
      camera.lookAt(0, 50, z); camera.updateMatrixWorld();
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      return meshes(forest).filter((m) => m.visible && frustum.intersectsObject(m)).map((m) => m.name);
    };
    const front = submitted(1200), back = submitted(-1200);
    expect(front).toHaveLength(1); expect(back).toHaveLength(1); expect(front).not.toEqual(back);
    expect(submitted(1200)).toEqual(front);
    forest.updateRange({ x: 9000, z: 9000 }); expect(meshes(forest).every((m) => !m.visible)).toBe(true);
    forest.updateRange({ x: 0, z: 0 }); expect(submitted(1200)).toEqual(front);
    forest.dispose(); source.target.dispose();
  });

  it('reuses untouched cells, releases removed/grown buffers, and keeps shared hooks/resources', () => {
    const source = atlas(), forest = new ForestBatches(source, 'test');
    new ObserverVisibility().attach(forest.root); // before first placement, as in main.ts
    const items = [plant(0, 0), plant(1200, 1200)]; forest.setItems(items);
    const [first, second] = meshes(forest);
    const firstDispose = vi.spyOn(first!, 'dispose'), secondDispose = vi.spyOn(second!, 'dispose');
    const materialDispose = vi.spyOn(forest.material, 'dispose'), textureDispose = vi.spyOn(source.target.texture, 'dispose');
    const geometryDispose = vi.spyOn(first!.geometry, 'dispose');
    forest.setItems([...items, plant(10, 10)]); // grows only the first cell
    expect(firstDispose).toHaveBeenCalledTimes(1); expect(secondDispose).not.toHaveBeenCalled();
    expect(meshes(forest)).toContain(second);
    expect(meshes(forest).every((m) => m.material === forest.material)).toBe(true);
    expect(forest.material.customProgramCacheKey()).toContain('observer-cutaway');
    forest.setItems([items[1]!]);
    expect(meshes(forest)).toEqual([second]); expect(materialDispose).not.toHaveBeenCalled();
    forest.setItems(); expect(secondDispose).toHaveBeenCalledTimes(1);
    forest.dispose(); forest.dispose();
    expect(materialDispose).toHaveBeenCalledTimes(1); expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).not.toHaveBeenCalled(); expect(forest.root.children).toHaveLength(0);
    source.target.dispose();
  });
});
