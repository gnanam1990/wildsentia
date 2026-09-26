import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { visualFor } from '../src/species.js';

// The live hare was later shrunk to 512 px textures from the same pinned source
// (tools/assets/shrink_rabbit_textures.py), which superseded this lossless WebP review.
// Both keep the source's non-image bytes, so they are compared with each other.
const source = readFileSync(new URL('../public/assets/animals/Rabbit.glb', import.meta.url));
const PINNED_SOURCE = '763c19a2606208f0560386b5e207b4995b0f71f857d75ebfa7f25af04956bfa3';
const review = readFileSync(new URL('../../../docs/art-review/rabbit-2026-09-25/RabbitLosslessWebPReview.glb', import.meta.url));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function unpack(bytes: Buffer) {
  expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
  expect(bytes.readUInt32LE(4)).toBe(2);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a);
  const binHeader = 20 + jsonLength;
  expect(bytes.readUInt32LE(binHeader + 4)).toBe(0x004e4942);
  const json = JSON.parse(bytes.toString('utf8', 20, binHeader));
  const bin = bytes.subarray(binHeader + 8);
  expect(bin.length).toBe(bytes.readUInt32LE(binHeader));
  expect(json.buffers[0].byteLength).toBe(bin.length);
  return { json, bin };
}

describe('review-only lossless Rabbit texture payload', () => {
  it('derives from the same pinned source as the live hare, which is now smaller than this review', () => {
    expect(unpack(source).json.asset.extras.textureBudget.sourceSha256).toBe(PINNED_SOURCE);
    expect(sha(review)).toBe('a6bf4165eba72356738954a79231f4c7034e0f40df2a01c6d894458acd699453');
    expect(review.length).toBe(3_309_144);
    expect(source.length).toBeLessThan(review.length);
    expect(visualFor('hare').model?.file).toBe('/assets/animals/Rabbit.glb');
  });

  it('preserves every non-image buffer view and all mesh/skin/animation/material semantics', () => {
    const a = unpack(source), b = unpack(review);
    const imageViews = new Set<number>(a.json.images.map((image: { bufferView: number }) => image.bufferView));
    for (const key of ['scene', 'scenes', 'nodes', 'meshes', 'skins', 'animations', 'accessors', 'materials', 'samplers'])
      expect(b.json[key], key).toEqual(a.json[key]);
    const { extras: _budget, ...liveAsset } = a.json.asset;
    expect(b.json.asset).toEqual(liveAsset);
    expect(b.json.bufferViews).toHaveLength(a.json.bufferViews.length);
    expect(b.json.images.map((image: { name: string }) => image.name))
      .toEqual(a.json.images.map((image: { name: string }) => image.name));
    for (let index = 0; index < a.json.bufferViews.length; index++) {
      const oldView = a.json.bufferViews[index], newView = b.json.bufferViews[index];
      expect(newView.buffer).toBe(oldView.buffer);
      expect(newView.target).toBe(oldView.target);
      expect(newView.byteStride).toBe(oldView.byteStride);
      expect(newView.byteOffset % 4).toBe(0);
      if (imageViews.has(index)) continue;
      expect(newView.byteLength).toBe(oldView.byteLength);
      expect(b.bin.subarray(newView.byteOffset, newView.byteOffset + newView.byteLength).equals(
        a.bin.subarray(oldView.byteOffset, oldView.byteOffset + oldView.byteLength)), `view ${index}`).toBe(true);
    }
    expect(b.json.skins.length).toBe(1);
    expect(b.json.animations.map((clip: { name: string }) => clip.name))
      .toEqual(['Basic', 'Dead', 'Death', 'Dying.001', 'Gallop', 'Idle', 'Jump', 'Resting', 'Sitting.001']);
  });

  it('uses required WebP extension and retains image order, dimensions and source texture samplers', () => {
    const a = unpack(source).json, { json, bin } = unpack(review);
    expect(json.extensionsUsed).toContain('EXT_texture_webp');
    expect(json.extensionsRequired).toContain('EXT_texture_webp');
    expect(json.textures).toHaveLength(3);
    for (let index = 0; index < 3; index++) {
      const image = json.images[index], view = json.bufferViews[image.bufferView];
      expect(image.mimeType).toBe('image/webp');
      expect(bin.toString('ascii', view.byteOffset, view.byteOffset + 4)).toBe('RIFF');
      expect(bin.toString('ascii', view.byteOffset + 8, view.byteOffset + 12)).toBe('WEBP');
      expect(json.textures[index].source).toBeUndefined();
      expect(json.textures[index].sampler).toBe(a.textures[index].sampler);
      expect(json.textures[index].extensions.EXT_texture_webp.source).toBe(index);
    }
  });
});
