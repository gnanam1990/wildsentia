import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { scannedGroundMaps } from '../src/terrain.js';
import { disposeTerrain } from '../src/environment.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('locally owned scanned ground', () => {
  it('ships the exact publisher downloads, not HTML login/error pages', () => {
    const hashes = { diff: '6ad9df4d731a238299806f739a26af83', nor_gl: 'a010a0802c2d9a930c6f00d3b1f196d2', rough: 'b5c7ba5c16f00261e9a765d52cf7e0ac' };
    for (const [suffix, hash] of Object.entries(hashes)) {
      const bytes = readFileSync(new URL(`../public/assets/ground/forest_ground_04_${suffix}_1k.jpg`, import.meta.url));
      expect(bytes.readUInt16BE(0)).toBe(0xffd8);
      expect(createHash('md5').update(bytes).digest('hex')).toBe(hash);
    }
  });
  it('uses colour/data spaces correctly and disposes each owned map once', () => {
    vi.stubGlobal('document', {});
    const loader = vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture());
    const maps = scannedGroundMaps();
    expect(loader.mock.calls.every(([url]) => url.startsWith('/assets/ground/'))).toBe(true);
    expect(maps.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(maps.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect(maps.roughnessMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect(maps.map!.repeat.x).toBe(6000 / 3.2);
    const textures = [maps.map!, maps.normalMap!, maps.roughnessMap!];
    const disposals = textures.map((t) => vi.spyOn(t, 'dispose'));
    const material = new THREE.MeshStandardMaterial(maps);
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(), material), new THREE.Mesh(new THREE.PlaneGeometry(), material));
    disposeTerrain(group);
    for (const disposal of disposals) expect(disposal).toHaveBeenCalledTimes(1);
  });
});
