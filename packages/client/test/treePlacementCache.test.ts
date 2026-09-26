import { describe, expect, it, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { canopyField, TreePlacementCache, NearVegetation, planVegetation } from '../src/vegetation.js';
import { makeHeightSampler, type PatchView } from '../src/terrain.js';

// No browser automation/GPU claim. Keep real instancing and update logic; replace only atlas rendering.
vi.mock('../src/treeLod.js', async () => ({
  ...await vi.importActual('../src/treeLod.js'),
  bakeTreeAtlas: () => ({ target: new THREE.WebGLRenderTarget(1, 1), centre: new THREE.Vector3(), diameter: 10 }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const patches: PatchView[] = Array.from({ length: 3 }, (_, i) => ({ id: 209 + i, x: 9 + i, y: 10,
  habitat: 'shola', grass: 1000, browse: 3000, water: 200, canopyCover: .8, elevation: .5,
  islandSeed: 1, surface: 'land' }));
const whole = (ps: PatchView[], ground: (x: number, z: number) => number) =>
  planVegetation(ps, { x: 2850, z: 2850 }, 4500, ground, { only: (kind) => kind.includes('Tree'), canopyAt: canopyField(ps) });

describe('world tree placement cache', () => {
  it('retains exact tree identities without terrain queries when only grass/browse/water values change', () => {
    const cache = new TreePlacementCache(), ground = vi.fn(makeHeightSampler(patches));
    const first = cache.get(patches, ground);
    expect(first).toEqual(whole(patches, ground)); ground.mockClear();
    const second = cache.get(patches.map((p) => ({ ...p, grass: 0, browse: 0, water: 30_000 })), ground);
    expect(second).toBe(first); expect(ground).not.toHaveBeenCalled();
    cache.clear(); expect(first.size).toBeGreaterThan(0); // never mutate a published map on clear
  });

  it('rebuilds a changed canopy patch and its neighbours only, preserving all other tree objects', () => {
    const cache = new TreePlacementCache(), ground = vi.fn(() => 0);
    const first = cache.get(patches, ground), identities = new Set([...first.values()].flat());
    ground.mockClear();
    const changed = patches.map((p, i) => i === 0 ? { ...p, canopyCover: .3 } : p);
    const next = cache.get(changed, ground), sampled = ground.mock.calls.length;
    expect(sampled).toBeGreaterThan(0);
    ground.mockClear(); const reference = whole(changed, ground);
    // Patch 209 changed; 210 borders it, so its edge thinning is re-planned; 211 does not.
    expect(next).toEqual(reference); expect(sampled).toBeLessThan(ground.mock.calls.length * 0.75);
    const reused = [...next.values()].flat().filter((p) => identities.has(p));
    const inPatch211 = (p: { x: number }) => p.x >= 11 * 300 - 150;
    expect(reused.length).toBe([...first.values()].flat().filter(inPatch211).length);
    expect(reused.every(inPatch211)).toBe(true);
    const tinyChange = changed.map((p) => ({ ...p, canopyCover: p.canopyCover! + 1e-8 }));
    // The existing renderer rounds tree counts; no extra rounding is introduced by the cache.
    expect(cache.get(tinyChange, ground)).toBe(next);
  });

  it('invalidates for habitat/surface/order/removal, height fields and replacement samplers', () => {
    const cache = new TreePlacementCache(); let source = structuredClone(patches);
    const ground = vi.fn(makeHeightSampler(patches)); cache.get(source, ground);
    for (const fields of [{ habitat: 'rock' }, { surface: 'coast' as const }, { surface: 'land' as const }]) {
      source = source.map((p, i) => i === 1 ? { ...p, ...fields } : p);
      expect(cache.get(source, ground)).toEqual(whole(source, ground));
    }
    source.reverse(); expect(cache.get(source, ground)).toEqual(whole(source, ground));
    source = source.slice(1); expect(cache.get(source, ground)).toEqual(whole(source, ground));
    source = source.map((p) => ({ ...p, islandSeed: 2 }));
    const seeded = makeHeightSampler(source); expect(cache.get(source, seeded)).toEqual(whole(source, seeded));
    source = source.map(({ islandSeed, surface, ...p }) => ({ ...p, elevation: .9 }));
    const mainland = makeHeightSampler(source); expect(cache.get(source, mainland)).toEqual(whole(source, mainland));
    ground.mockClear(); cache.get(source, ground); expect(ground).toHaveBeenCalled();
    cache.get([], ground); ground.mockClear(); cache.get(source, ground); expect(ground).toHaveBeenCalled();
  });

  it('observes in-place patch edits and height changes even behind a stable sampler closure', () => {
    const source = patches.map(({ islandSeed, surface, ...p }) => p);
    const cache = new TreePlacementCache(); let sampler = makeHeightSampler(source);
    const ground = vi.fn((x: number, z: number) => sampler(x, z));
    const before = cache.get(source, ground); source[0]!.elevation = .1;
    sampler = makeHeightSampler(source); ground.mockClear();
    const after = cache.get(source, ground);
    expect(after).not.toBe(before); expect(ground).toHaveBeenCalled(); expect(after).toEqual(whole(source, ground));
    source[0]!.canopyCover = 0;
    expect(cache.get(source, ground)).toEqual(whole(source, ground));
  });

  it('reuses distant spatial buffers on grass checkpoints and camera moves; canopy changes replace only affected cells', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const scene = new THREE.Group(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 8, 1), new THREE.MeshStandardMaterial()));
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene } as never);
    const layer = new NearVegetation(patches, () => 10); await layer.load({} as THREE.WebGLRenderer);
    const focus = { x: 2850, y: 14, z: 2850 };
    layer.update(focus);
    const group = layer.root.getObjectByName('forest-lod:CommonTree_1')!;
    const mesh = group.children.find((m) => (m as THREE.InstancedMesh).count > 0) as THREE.InstancedMesh;
    expect(mesh.count).toBeGreaterThan(0);
    const before = mesh.instanceMatrix.array.slice(), version = mesh.instanceMatrix.version;
    layer.setPatches(patches.map((p) => ({ ...p, grass: 0 }))); layer.update(focus);
    expect(mesh.instanceMatrix.version).toBe(version); expect(mesh.instanceMatrix.array).toEqual(before);
    layer.setPatches(patches.map((p) => ({ ...p, canopyCover: 0 }))); layer.update(focus);
    expect(group.children).not.toContain(mesh); // obsolete buffers removed, not held forever
    layer.setPatches(patches); layer.update(focus);
    const restored = group.children.find((m) => (m as THREE.InstancedMesh).count > 0) as THREE.InstancedMesh;
    expect(restored).toBeDefined(); const restoredVersion = restored.instanceMatrix.version;
    layer.update({ x: 9000, y: 14, z: 9000 }); expect(restored.visible).toBe(false);
    layer.update(focus); expect(restored.visible).toBe(true);
    expect(restored.instanceMatrix.version).toBe(restoredVersion);
    layer.dispose(); expect(layer.root.children).toHaveLength(0);
  });
});
