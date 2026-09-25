import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NearVegetation, natureAssetFile } from '../src/vegetation.js';

const root = new URL('../public/assets/nature/', import.meta.url);
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function glb(name: string) {
  const data = readFileSync(new URL(name, root));
  expect(data.subarray(0, 4).toString()).toBe('glTF');
  expect(data.readUInt32LE(8)).toBe(data.length);
  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString());
  const bin = data.subarray(28 + jsonLength);
  const view = (index: number): Buffer => {
    const { byteOffset = 0, byteLength } = json.bufferViews[index];
    return bin.subarray(byteOffset, byteOffset + byteLength);
  };
  return { data, json, view };
}

describe('pixel-exact natural-tree leaf payload', () => {
  it.each([
    ['NaturalBroadleafSpreading.glb', 'NaturalBroadleafSpreadingWebP.glb', 6_502_704, 6_253_040,
      '8e640daf8f1207918d9600063a3e96e909da8ba7546c6182b710c89adc3dc3c3'],
    ['NaturalBroadleafUpright.glb', 'NaturalBroadleafUprightWebP.glb', 7_534_208, 7_132_076,
      'd7d87b1a352bc1d8296044b61cdfa9b7c2e81a47410307008df15ff05f1b4400'],
  ] as const)('%s has a smaller reviewed derivative with identical geometry and non-leaf images',
    (sourceName, outputName, sourceBytes, outputBytes, outputHash) => {
      const source = glb(sourceName), output = glb(outputName);
      expect(source.data.length).toBe(sourceBytes);
      expect(output.data.length).toBe(outputBytes);
      expect(digest(output.data)).toBe(outputHash);
      expect(natureAssetFile(sourceName, true)).toBe(outputName);
      expect(natureAssetFile(sourceName, false)).toBe(sourceName);
      for (const key of ['asset', 'scenes', 'scene', 'nodes', 'meshes', 'accessors', 'materials', 'samplers'])
        expect(output.json[key]).toEqual(source.json[key]);
      expect(output.json.images).toHaveLength(source.json.images.length);
      expect(output.json.textures).toHaveLength(source.json.textures.length);
      expect(output.json.bufferViews).toHaveLength(source.json.bufferViews.length);
      const leafIndex = source.json.images.findIndex((image: { mimeType: string }) => image.mimeType === 'image/png');
      expect(leafIndex).toBeGreaterThanOrEqual(0);
      expect(source.json.images.filter((image: { mimeType: string }) => image.mimeType === 'image/png')).toHaveLength(1);
      expect(output.json.images[leafIndex]).toEqual({ ...source.json.images[leafIndex], mimeType: 'image/webp' });
      for (let i = 0; i < source.json.textures.length; i++) {
        const original = source.json.textures[i];
        if (original.source === leafIndex)
          expect(output.json.textures[i]).toEqual({ sampler: original.sampler,
            extensions: { EXT_texture_webp: { source: leafIndex } } });
        else expect(output.json.textures[i]).toEqual(original);
      }
      expect(output.json.extensionsRequired).toContain('EXT_texture_webp');
      for (let i = 0; i < source.json.bufferViews.length; i++) {
        const original = source.json.bufferViews[i], revised = output.json.bufferViews[i];
        if (i === source.json.images[leafIndex].bufferView) {
          expect(revised.byteLength).toBeLessThan(original.byteLength);
          expect(output.view(i).subarray(0, 4).toString()).toBe('RIFF');
        } else {
          expect(revised.byteLength).toBe(original.byteLength);
          expect(output.view(i).equals(source.view(i))).toBe(true);
        }
      }
    });

  it('keeps non-tree nature models on their original URLs', () => {
    expect(natureAssetFile('NaturalBoulder.glb', true)).toBe('NaturalBoulder.glb');
    expect(natureAssetFile('Fern_1.glb', true)).toBe('Fern_1.glb');
  });

  it.each([true, false])('loads each tree source once with WebP support = %s', async (supported) => {
    vi.stubGlobal('document', { createElement: () => ({ width: 300, height: 150,
      toDataURL: () => supported ? 'data:image/webp;base64,' : 'data:image/png;base64,' }) });
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene: new THREE.Group() } as never);
    const layer = new NearVegetation([], () => 0);
    try {
      await layer.load();
      for (const source of ['NaturalBroadleafSpreading.glb', 'NaturalBroadleafUpright.glb']) {
        const selected = natureAssetFile(source, supported);
        expect(load.mock.calls.filter(([url]) => url.endsWith(`/${selected}`))).toHaveLength(1);
      }
    } finally {
      layer.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
