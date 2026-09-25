import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NATURE_KINDS } from '../src/vegetation.js';

describe('packaged natural rocks', () => {
  it.each([
    ['NaturalBoulder', 'boulder_01', 6000, 3_100_000],
    ['NaturalStone', 'rock_07', 2000, 1_800_000],
  ] as const)('%s has bounded, valid geometry and unchanged embedded source textures', (name, source, triangles, maxBytes) => {
    const bytes = readFileSync(new URL(`../public/assets/nature/${name}.glb`, import.meta.url));
    expect(bytes.subarray(0, 4).toString()).toBe('glTF');
    expect(bytes.readUInt32LE(8)).toBe(bytes.length); expect(bytes.length).toBeLessThan(maxBytes);
    const jsonLength = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
    const binary = bytes.subarray(28 + jsonLength);
    expect(gltf.buffers).toEqual([{ byteLength: binary.length }]);
    expect(gltf.asset.copyright).toContain('CC0');
    expect(gltf.asset.extras.source).toBe(`https://polyhaven.com/a/${source}`);
    expect(gltf.asset.extras.geologyAccurate).toBe(false);
    expect(gltf.asset.extras.simplificationError).toBeLessThanOrEqual(0.03);
    expect(gltf.meshes).toHaveLength(1); expect(gltf.nodes).toEqual([{ mesh: 0, name }]);
    const primitive = gltf.meshes[0].primitives[0];
    const positions = gltf.accessors[primitive.attributes.POSITION];
    expect(positions.min[1]).toBeCloseTo(0); expect(positions.max[1]).toBeCloseTo(1);
    expect(positions.min[0]).toBeCloseTo(-positions.max[0]);
    expect(positions.min[2]).toBeCloseTo(-positions.max[2]);
    expect(positions.count).toBeLessThan(20_000);
    for (const name of ['POSITION', 'NORMAL', 'TEXCOORD_0']) {
      const a = gltf.accessors[primitive.attributes[name]], v = gltf.bufferViews[a.bufferView];
      expect(a.componentType).toBe(5126); expect(a.count).toBe(positions.count);
      for (let i = 0; i < v.byteLength; i += 4) expect(Number.isFinite(binary.readFloatLE(v.byteOffset + i))).toBe(true);
    }
    const indices = gltf.accessors[primitive.indices], view = gltf.bufferViews[indices.bufferView];
    expect(indices.count / 3).toBe(triangles); expect(indices.componentType).toBe(5123);
    for (let i = 0; i < indices.count; i++) expect(binary.readUInt16LE(view.byteOffset + i * 2)).toBeLessThan(positions.count);
    const material = gltf.materials[primitive.material];
    expect(material.pbrMetallicRoughness.metallicFactor).toBe(0);
    expect(material.occlusionTexture.index).toBe(material.pbrMetallicRoughness.metallicRoughnessTexture.index);
    for (const [binding, suffix] of [
      [material.pbrMetallicRoughness.baseColorTexture, 'diff'],
      [material.normalTexture, 'nor_gl'],
      [material.pbrMetallicRoughness.metallicRoughnessTexture, 'arm'],
    ]) {
      const image = gltf.images[gltf.textures[binding.index].source];
      expect(image.uri).toBeUndefined(); expect(image.mimeType).toBe('image/jpeg');
      const v = gltf.bufferViews[image.bufferView];
      const md5 = createHash('md5').update(binary.subarray(v.byteOffset, v.byteOffset + v.byteLength)).digest('hex');
      expect(md5).toBe(gltf.asset.extras.sourceFilesMD5[`textures/${source}_${suffix}_1k.jpg`]);
    }
  });

  it('uses both reviewed sources across every stone/rock/boulder kind', () => {
    const rocks = Object.entries(NATURE_KINDS).filter(([name]) => /^(Stone_|Rock_|Boulder_)/.test(name));
    expect(rocks).toHaveLength(5);
    expect(new Set(rocks.map(([, config]) => config.file))).toEqual(new Set(['NaturalBoulder.glb', 'NaturalStone.glb']));
  });
});
