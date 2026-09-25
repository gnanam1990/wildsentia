import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { TerrainCheckpoints, terrainKeys } from '../src/terrainCheckpoints.js';
import { buildTerrain, hideFarFieldNear, makeHeightSampler, type PatchView } from '../src/terrain.js';
import { disposeTerrain } from '../src/environment.js';

const patches: PatchView[] = [
  { id: 210, x: 10, y: 10, habitat: 'shola', grass: 4000, browse: 100, water: 200, canopyCover: .8, elevation: .5, islandSeed: 1, surface: 'land' },
  { id: 211, x: 11, y: 10, habitat: 'rock', grass: 200, browse: 0, water: 25_000, canopyCover: 0, elevation: .5, islandSeed: 1, surface: 'land' },
];
const bytes = (array: ArrayBufferView) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
function sameAsRebuild(root: THREE.Group, source: PatchView[]) {
  const reference = buildTerrain(source);
  expect(root.children.map((c) => c.name).sort()).toEqual(reference.children.map((c) => c.name).sort());
  for (const item of reference.children as THREE.Mesh[]) {
    const actual = root.getObjectByName(item.name) as THREE.Mesh;
    for (const key of Object.keys(item.geometry.attributes)) {
      expect(bytes(actual.geometry.getAttribute(key).array).equals(bytes(item.geometry.getAttribute(key).array)), `${item.name}.${key}`).toBe(true);
    }
    if ((item as THREE.InstancedMesh).isInstancedMesh) {
      const a = actual as THREE.InstancedMesh, b = item as THREE.InstancedMesh;
      expect(a.count).toBe(b.count);
      expect(bytes(a.instanceMatrix.array).equals(bytes(b.instanceMatrix.array)), item.name).toBe(true);
    }
  }
  disposeTerrain(reference);
}

describe('checkpoint terrain layer reuse', () => {
  it('does not allocate or detach unchanged layers during preparation and preserves the height sampler', () => {
    const owner = new TerrainCheckpoints(), first = owner.prepare(patches);
    const root = owner.commit(first), children = [...root.children];
    const changed = patches.map((p) => ({ ...p, browse: p.browse + 2, canopyCover: p.canopyCover ? .9 : 0 }));
    const second = owner.prepare(changed);
    expect(second.root.children).toHaveLength(0); expect(root.children).toEqual(children);
    expect(second.height).toBe(first.height);
    const next = owner.commit(second);
    expect(root.children).toHaveLength(0);
    for (const child of children) expect(next.getObjectByName(child.name)).toBe(child);
    sameAsRebuild(next, changed); owner.dispose();
  });

  it('rebuilds only changed resource layers, with exact full-build output across vegetation and water thresholds', () => {
    const owner = new TerrainCheckpoints(); let source = structuredClone(patches);
    let root = owner.commit(owner.prepare(source));
    const updates: Array<[Partial<PatchView>, string[]]> = [
      [{ grass: 3000 }, ['grass']],
      [{ water: 30_000 }, ['grass', 'water']],
      [{ water: 35_000 }, ['water']],
      [{ canopyCover: .2 }, ['trunk', 'canopy']],
      [{ habitat: 'rock' }, ['ground', 'rock', 'trunk', 'canopy']],
      [{ surface: 'coast' }, ['water', 'rock']],
    ];
    for (const [fields, names] of updates) {
      source = source.map((p, i) => i === 0 ? { ...p, ...fields } : p);
      const prepared = owner.prepare(source);
      expect(prepared.root.children.map((c) => c.name).sort()).toEqual(names.sort());
      root = owner.commit(prepared); sameAsRebuild(root, source);
    }
    owner.dispose();
  });

  it('keeps edited keys immutable and invalidates all height-dependent layers on mainland elevation/seed changes', () => {
    const owner = new TerrainCheckpoints();
    const first = owner.prepare(patches); owner.commit(first);
    const otherIsland = patches.map((p) => ({ ...p, islandSeed: 2 }));
    const second = owner.prepare(otherIsland);
    expect(second.height).not.toBe(first.height);
    sameAsRebuild(owner.commit(second), otherIsland);
    const mainland = patches.map(({ islandSeed, surface, ...p }) => p);
    const third = owner.prepare(mainland); const root = owner.commit(third);
    expect(root.getObjectByName('ocean')).toBeUndefined(); sameAsRebuild(root, mainland);
    mainland[0]!.elevation = .9;
    const fourth = owner.prepare(mainland);
    expect(fourth.height).not.toBe(third.height);
    expect(fourth.height(3100, 3000)).toBe(makeHeightSampler(mainland)(3100, 3000));
    sameAsRebuild(owner.commit(fourth), mainland); owner.dispose();
  });

  it('does not discard or double-dispose reused geometry, maps, or instance buffers', () => {
    const owner = new TerrainCheckpoints(); const first = owner.prepare(patches);
    const root = owner.commit(first);
    const ground = root.getObjectByName('ground') as THREE.Mesh;
    const material = ground.material as THREE.MeshStandardMaterial;
    const texture = new THREE.Texture(); material.map = texture; material.normalMap = texture;
    const geometryDispose = vi.spyOn(ground.geometry, 'dispose'), textureDispose = vi.spyOn(texture, 'dispose');
    const grass = root.getObjectByName('grass') as THREE.InstancedMesh;
    const instanceDispose = vi.spyOn(grass, 'dispose');
    const changed = patches.map((p) => ({ ...p, grass: 600 }));
    const unused = owner.prepare(changed), replacement = unused.root.getObjectByName('grass') as THREE.InstancedMesh;
    const replacementDispose = vi.spyOn(replacement, 'dispose');
    owner.discard(unused); owner.discard(unused);
    expect(replacementDispose).toHaveBeenCalledTimes(1); expect(instanceDispose).not.toHaveBeenCalled();
    expect(geometryDispose).not.toHaveBeenCalled(); expect(textureDispose).not.toHaveBeenCalled();
    owner.commit(owner.prepare(changed));
    expect(instanceDispose).toHaveBeenCalledTimes(1); expect(geometryDispose).not.toHaveBeenCalled();
    owner.dispose(); owner.dispose(); owner.discard(first);
    expect(geometryDispose).toHaveBeenCalledTimes(1); expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(instanceDispose).toHaveBeenCalledTimes(1);
  });

  it('rejects stale preparations and cleans pending layers without disturbing the committed scene', () => {
    const owner = new TerrainCheckpoints(); owner.commit(owner.prepare(patches));
    const a = owner.prepare(patches.map((p) => ({ ...p, grass: 1000 })));
    const b = owner.prepare(patches.map((p) => ({ ...p, grass: 2000 })));
    const committed = owner.commit(a), before = [...committed.children];
    expect(() => owner.commit(b)).toThrow('Stale');
    expect(committed.children).toEqual(before); owner.discard(b);
    expect(committed.children).toEqual(before);
    const pending = owner.prepare(patches.map((p) => ({ ...p, habitat: 'marsh' })));
    owner.dispose(); expect(pending.root.children).toHaveLength(0);
    expect(() => owner.commit(pending)).toThrow(); expect(() => owner.prepare(patches)).toThrow('disposed');
  });

  it('preserves observer-hidden matrices until the next view update without mutating shared source arrays', () => {
    const owner = new TerrainCheckpoints(); const initial = owner.prepare(patches), root = owner.commit(initial);
    hideFarFieldNear(root, { x: 3000, z: 3000 }, 220, Infinity, 132);
    const grass = root.getObjectByName('grass') as THREE.InstancedMesh;
    const matrixBefore = grass.instanceMatrix.array.slice(), version = grass.instanceMatrix.version;
    const second = owner.prepare(patches); owner.commit(second);
    expect(bytes(grass.instanceMatrix.array).equals(bytes(matrixBefore))).toBe(true);
    expect(grass.instanceMatrix.version).toBe(version);
    expect(second.root.getObjectByName('trunk')!.visible).toBe(false);
    owner.dispose();
  });

  it('derives keys from exact render inputs rather than rounding biomass or relying on mutable patch references', () => {
    const original = terrainKeys(patches);
    const fractional = patches.map((p) => ({ ...p, grass: p.grass + .00001 }));
    expect(terrainKeys(fractional).grass).not.toBe(original.grass);
    expect(terrainKeys(fractional).ground).toBe(original.ground);
    const ordered = patches.map((p) => ({ ...p, water: 0 })); // both contribute grass instances
    expect(terrainKeys([...ordered].reverse()).grass).not.toBe(terrainKeys(ordered).grass);
    const capped = patches.map((p) => ({ ...p, grass: 8000 }));
    expect(terrainKeys(capped).grass).toBe(terrainKeys(capped.map((p) => ({ ...p, grass: 9000 }))).grass);
  });
});
