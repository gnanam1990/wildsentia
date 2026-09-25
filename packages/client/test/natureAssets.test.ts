import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NATURE_KINDS, TREE_ROOT_SEATING } from '../src/vegetation.js';

describe('natural broadleaf delivery', () => {
  it.each(['NaturalBroadleafSpreading', 'NaturalBroadleafUpright'])('%s is a bounded, textured local GLB with depth-writing foliage', (name) => {
    const data = readFileSync(new URL(`../public/assets/nature/${name}.glb`, import.meta.url));
    expect(data.subarray(0, 4).toString()).toBe('glTF');
    expect(data.readUInt32LE(8)).toBe(data.length);
    expect(data.length).toBeLessThan(8_000_000);
    const length = data.readUInt32LE(12);
    const gltf = JSON.parse(data.subarray(20, 20 + length).toString());
    expect(gltf.asset.copyright).toContain('CC0');
    expect(gltf.asset.extras.speciesAccurate).toBe(false);
    expect(gltf.buffers).toHaveLength(1);
    expect(gltf.buffers[0].uri).toBeUndefined();
    expect(gltf.images.every((image: { bufferView?: number; uri?: string }) => image.bufferView !== undefined && !image.uri)).toBe(true);
    const leaf = gltf.materials.find((m: { name: string }) => m.name.includes('leaves'));
    expect(leaf.alphaMode).toBe('MASK');
    expect(leaf.alphaCutoff).toBe(0.5);
    expect(leaf.doubleSided).toBe(true);
    expect(leaf.normalTexture).toBeDefined();
    expect(leaf.pbrMetallicRoughness.baseColorTexture).toBeDefined();
    // The middle-distance GPU LOD may thin only independent photographed leaf cards.
    // If an asset revision changes topology, fail before the runtime could discard
    // arbitrary indexed triangles under an incorrect six-index-card assumption.
    const leafPrimitive = gltf.meshes.flatMap((mesh: { primitives: Array<{ material: number; indices: number }> }) => mesh.primitives)
      .find((primitive: { material: number }) => gltf.materials[primitive.material] === leaf);
    expect(leafPrimitive).toBeDefined();
    const leafIndices = gltf.accessors[leafPrimitive.indices];
    const leafView = gltf.bufferViews[leafIndices.bufferView];
    expect(leafIndices.componentType).toBe(5125);
    expect(leafIndices.count).toBeGreaterThan(150_000);
    expect(leafIndices.count % 6).toBe(0);
    const leafStart = 28 + length + (leafView.byteOffset ?? 0) + (leafIndices.byteOffset ?? 0);
    for (let i = 0; i < leafIndices.count; i += 6) {
      const corners = new Set<number>();
      for (let k = 0; k < 6; k++) corners.add(data.readUInt32LE(leafStart + (i + k) * 4));
      expect(corners.size).toBe(4);
    }
    let triangles = 0;
    let rootRadius = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
      expect(primitive.attributes.TEXCOORD_0).toBeDefined();
      triangles += gltf.accessors[primitive.indices].count / 3;
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      const view = gltf.bufferViews[accessor.bufferView];
      const start = 28 + length + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      expect(accessor.componentType).toBe(5126);
      for (let i = 0; i < accessor.count; i++) {
        const vertex: number[] = [];
        for (let c = 0; c < 3; c++) {
          const value = data.readFloatLE(start + i * (view.byteStride ?? 12) + c * 4);
          expect(Number.isFinite(value)).toBe(true);
          vertex.push(value);
          min[c] = Math.min(min[c]!, value); max[c] = Math.max(max[c]!, value);
        }
        if (vertex[1]! < 0.15) rootRadius = Math.max(rootRadius, Math.hypot(vertex[0]!, vertex[2]!));
      }
    }
    expect(triangles).toBeGreaterThan(40_000);
    expect(triangles).toBeLessThan(75_000);
    expect(min[1]).toBeCloseTo(0, 3);
    expect(max[1]).toBeCloseTo(8, 3);
    expect(rootRadius).toBeGreaterThan(0);
    expect(rootRadius).toBeLessThan(TREE_ROOT_SEATING[`${name}.glb`]!.radius);
    // Detect an accidentally retained authoring-scene translation / detached trunk.
    expect(max[0]! - min[0]!).toBeLessThan(12);
    expect(max[2]! - min[2]!).toBeLessThan(12);
    for (const node of gltf.nodes) {
      expect(node.translation ?? [0, 0, 0]).toEqual([0, 0, 0]);
      expect(node.scale ?? [1, 1, 1]).toEqual([1, 1, 1]);
    }
  });
  it('uses the new local trees for every living canopy kind', () => {
    const trees = Object.entries(NATURE_KINDS).filter(([kind]) => kind.includes('Tree') && !kind.startsWith('Dead'));
    expect(trees).toHaveLength(6);
    expect(new Set(trees.map(([, config]) => config.file)).size).toBe(2);
    expect(trees.every(([, config]) => config.file.startsWith('NaturalBroadleaf'))).toBe(true);
  });
});
