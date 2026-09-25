import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NearVegetation } from '../src/vegetation.js';

afterEach(() => vi.restoreAllMocks());

function source() {
  const scene = new THREE.Group();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture, roughnessMap: texture });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 8, 1), material));
  return { scene, texture, material };
}

describe('nature asset ownership', () => {
  it('shares a sparse leaf-card index across reused tree kinds without drawing duplicate foliage before atlas readiness', async () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 4 * 3), 3));
    const indices: number[] = [];
    for (let card = 0; card < 16; card++) indices.push(card * 4, card * 4 + 1,
      card * 4 + 2, card * 4 + 2, card * 4 + 1, card * 4 + 3);
    geometry.setIndex(indices);
    const material = new THREE.MeshStandardMaterial(); material.name = 'review_leaves';
    const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry, material));
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene } as never);
    const layer = new NearVegetation([{ id: 0, x: 0, y: 0, habitat: 'shola', grass: 1000,
      browse: 2000, water: 0, canopyCover: 0.8 }], () => 0);
    await layer.load();
    const full = layer.root.getObjectByName('nature:CommonTree_1') as THREE.InstancedMesh;
    const middle = layer.root.getObjectByName('nature-lod:CommonTree_1') as THREE.InstancedMesh;
    const reused = layer.root.getObjectByName('nature-lod:CommonTree_4') as THREE.InstancedMesh;
    expect(middle.geometry).toBe(reused.geometry);
    expect(middle.geometry.getAttribute('position')).toBe(full.geometry.getAttribute('position'));
    expect(middle.geometry.getIndex()?.count).toBe(full.geometry.getIndex()!.count / 2);
    expect(middle.material).not.toBe(full.material);
    layer.update({ x: 150, z: 150 });
    expect((layer.root.getObjectByName('nature:CommonTree_1') as THREE.InstancedMesh).count).toBeGreaterThan(0);
    expect(middle.count).toBe(0); // No renderer/atlas: only the original full foliage is shown.
    const sparseDispose = vi.spyOn(middle.geometry, 'dispose');
    layer.dispose();
    expect(sparseDispose).toHaveBeenCalledOnce();
  });

  it('isolates material/shader state per placement kind and releases shared maps only once', async () => {
    const asset = source();
    const sourceGeometry = (asset.scene.children[0] as THREE.Mesh).geometry;
    const clone = vi.spyOn(sourceGeometry, 'clone');
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene: asset.scene } as never);
    const layer = new NearVegetation([], () => 0);
    await layer.load();
    // Stone_Small and Rock_Medium_2 intentionally share one source file, not one mutable shader.
    const stone = layer.root.getObjectByName('nature:Stone_Small') as THREE.InstancedMesh;
    const rock = layer.root.getObjectByName('nature:Rock_Medium_2') as THREE.InstancedMesh;
    expect(stone.material).not.toBe(rock.material);
    expect(stone.material).not.toBe(asset.material);
    expect(stone.geometry).toBe(rock.geometry);
    expect(stone.geometry).not.toBe(sourceGeometry);
    expect(clone).toHaveBeenCalledOnce();
    expect((stone.material as THREE.MeshStandardMaterial).map).toBe(asset.texture);
    expect(load.mock.calls.filter(([url]) => url.endsWith('/NaturalStone.glb'))).toHaveLength(1);
    expect(load.mock.calls.filter(([url]) => url.endsWith('/NaturalBoulder.glb'))).toHaveLength(1);
    expect(rock.castShadow).toBe(true); expect(stone.castShadow).toBe(false);
    const textureDispose = vi.spyOn(asset.texture, 'dispose');
    const geometryDispose = vi.spyOn(stone.geometry, 'dispose');
    const materialDispose = vi.spyOn(stone.material as THREE.Material, 'dispose');
    stone.customDepthMaterial = new THREE.MeshDepthMaterial({ map: asset.texture });
    const depthDispose = vi.spyOn(stone.customDepthMaterial, 'dispose');
    layer.dispose(); layer.dispose();
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(depthDispose).toHaveBeenCalledTimes(1);
    expect(layer.root.children).toHaveLength(0);
    expect(layer.update({ x: 0, z: 0 })).toBe(false);
  });
  it('waits for all concurrent loads and cleans partial assets before reporting failure', async () => {
    const asset = source();
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async (url) => {
      if (url.endsWith('/Fern_1.glb')) throw new Error('Missing model');
      return { scene: asset.scene } as never;
    });
    const textureDispose = vi.spyOn(asset.texture, 'dispose');
    const layer = new NearVegetation([], () => 0);
    await expect(layer.load()).rejects.toThrow('Nature assets could not be loaded');
    expect(layer.root.children).toHaveLength(0);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(layer.hasTreeLod).toBe(false);
  });
  it('refreshes visible instances when the observer turns without moving or reshuffling the forest', async () => {
    const asset = source();
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene: asset.scene } as never);
    const layer = new NearVegetation([{ id: 0, x: 0, y: 0, habitat: 'shola', grass: 1000,
      browse: 2000, water: 0, canopyCover: 0.8 }], () => 0);
    await layer.load();
    const focus = { x: 0, y: 4, z: 0 };
    layer.update(focus);
    const mesh = layer.root.getObjectByName('nature:CommonTree_1') as THREE.InstancedMesh;
    const fullCount = mesh.count;
    const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 3000);
    camera.position.set(focus.x, focus.y, focus.z); camera.lookAt(0, 4, -100);
    expect(layer.update(focus, camera)).toBe(false); // view changed, not world-wide coverage
    const first = [...mesh.instanceMatrix.array.slice(0, mesh.count * 16)];
    expect(mesh.count).toBeGreaterThan(0);
    expect(mesh.count).toBeLessThan(fullCount);
    expect(layer.update(focus, camera)).toBe(false);
    const version = mesh.instanceMatrix.version;
    camera.lookAt(0.000001, 4, -100); // tiny orbit: same membership, no redundant GPU upload
    layer.update(focus, camera);
    expect(mesh.instanceMatrix.version).toBe(version);
    camera.lookAt(0, 4, 100);
    expect(layer.update(focus, camera)).toBe(false);
    expect([...mesh.instanceMatrix.array.slice(0, mesh.count * 16)]).not.toEqual(first);
    camera.lookAt(0, 4, -100);
    layer.update(focus, camera);
    expect([...mesh.instanceMatrix.array.slice(0, mesh.count * 16)]).toEqual(first);
    layer.dispose();
  });
});
