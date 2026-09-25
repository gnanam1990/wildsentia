import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { elephantSurface } from '../src/elephantSurface.js';

describe('local Asian-elephant surface grade', () => {
  it('keeps the source map/material intact and grades only mapped standard materials', () => {
    const map = new THREE.DataTexture(new Uint8Array([90, 60, 48, 255]), 1, 1);
    const source = new THREE.MeshStandardMaterial({ map, color: 0xffffff });
    const plain = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [source, plain]);
    root.add(mesh);
    elephantSurface(root);
    const [graded, untouched] = mesh.material as THREE.Material[];
    expect(graded).not.toBe(source);
    expect((graded as THREE.MeshStandardMaterial).map).toBe(map);
    expect(untouched).toBe(plain);
    expect(source.onBeforeCompile.toString()).not.toContain('vanaLuma');
    const shader = { fragmentShader: '#include <map_fragment>' } as THREE.WebGLProgramParametersWithUniforms;
    graded!.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('vanaEarthGrey');
    expect(graded!.customProgramCacheKey()).toBe('vana-elephant-earth-grey-v2');
  });
  it('can grade an already-owned material after Three.js cloning', () => {
    const map = new THREE.DataTexture(new Uint8Array([90, 60, 48, 255]), 1, 1);
    const source = new THREE.MeshStandardMaterial({ map });
    const owned = source.clone();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), owned);
    elephantSurface(mesh, false);
    expect(mesh.material).toBe(owned);
    expect(owned.customProgramCacheKey()).toBe('vana-elephant-earth-grey-v2');
    expect(source.customProgramCacheKey()).not.toBe('vana-elephant-earth-grey-v2');
  });
});
