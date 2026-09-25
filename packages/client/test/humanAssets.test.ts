import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const root = new URL('../public/assets/humans-v1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('build.json', root), 'utf8'));
describe('shipped CC0 human assemblies', () => {
  it.each(['female', 'male'])('%s is a bounded self-contained asset with actual retargeted skin motion', async sex => {
    const filename = `human-${sex}.glb`, bytes = readFileSync(new URL(filename, root));
    const source = manifest.files.find((f: { filename: string }) => f.filename === filename);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    expect(bytes.length).toBe(source.bytes); expect(bytes.length).toBeLessThan(3_000_000);
    expect(bytes.readUInt32LE(8)).toBe(bytes.length);
    const len = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + len).toString());
    const binary = bytes.subarray(28 + len, 28 + len + json.buffers[0].byteLength);
    expect(json.buffers).toHaveLength(1); expect(json.buffers[0].uri).toBeUndefined();
    expect(json.skins).toHaveLength(1); expect(json.skins[0].joints).toHaveLength(65);
    expect(json.images.length).toBeGreaterThan(4);
    for (const image of json.images) { expect(image.uri).toBeUndefined(); expect(image.bufferView).toBeTypeOf('number'); }
    for (const name of manifest.clips) expect(json.animations.some((a: { name: string }) => a.name === name)).toBe(true);
    // Geometry-only load uses the same Three.js skinning as runtime, without browser image APIs.
    delete json.images; delete json.textures; delete json.materials;
    for (const mesh of json.meshes) for (const p of mesh.primitives) delete p.material;
    json.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
    const previous = globalThis.ProgressEvent;
    if (!previous) globalThis.ProgressEvent = class { constructor(_type: string, init: object) { Object.assign(this, init); } } as unknown as typeof ProgressEvent;
    try {
      const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
      const mixer = new THREE.AnimationMixer(gltf.scene), skinned: THREE.SkinnedMesh[] = [];
      gltf.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
      expect(skinned.length).toBeGreaterThan(6);
      const point = new THREE.Vector3();
      for (const clip of gltf.animations) {
        const samples: number[][] = [];
        for (const fraction of [0, .25, .5, .75, .9999]) {
          mixer.stopAllAction(); const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.reset().play(); mixer.setTime(clip.duration * fraction);
          gltf.scene.updateMatrixWorld(true); const bounds = new THREE.Box3();
          for (const mesh of skinned) {
            mesh.skeleton.update();
            for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
              mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld); bounds.expandByPoint(point);
              if (!Number.isFinite(point.x + point.y + point.z)) throw new Error(`Nonfinite ${clip.name}`);
            }
          }
          expect(bounds.getSize(new THREE.Vector3()).length(), clip.name).toBeLessThan(3.5);
          expect(bounds.min.y, `${clip.name} ground penetration`).toBeGreaterThan(-.18);
          expect(bounds.max.y, `${clip.name} bounded height`).toBeLessThan(2.2);
          if (clip.name === 'Death01' && fraction > .99) expect(bounds.max.y).toBeLessThan(.6);
          samples.push([...bounds.min.toArray(), ...bounds.max.toArray()]);
        }
        expect(samples.some(s => s.some((v, i) => Math.abs(v - samples[0]![i]!) > 1e-4)), `${clip.name} changes posed geometry`).toBe(true);
      }
    } finally { globalThis.ProgressEvent = previous; }
  });
  it('ships all three publisher CC0 licenses and retains source provenance', () => {
    for (const pack of ['humans-base', 'humans-outfits', 'humans-motion']) {
      expect(readFileSync(new URL(`${pack}-LICENSE.txt`, root), 'utf8')).toContain('CC0 1.0');
      expect(manifest.sources[pack]).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
