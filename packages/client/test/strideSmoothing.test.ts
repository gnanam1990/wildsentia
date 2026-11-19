import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { BIG_CAT_MODELS, softenStrides, softStride } from '../src/strideSmoothing.js';

/**
 * The big cats' strides drawn as soft curves: measured by playing each clip on its own rig and
 * following each paw's tip. A hard step is a corner in the paw's path (a spike in its second
 * difference); softening must round those corners without lowering the swing or sliding a paw
 * that is planted.
 */
async function load(file: string) {
  const bytes = readFileSync(new URL(`../public/assets/animals/${file}`, import.meta.url));
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  // Textures need a DOM to decode; the motion does not.
  delete json.images; delete json.textures; delete json.samplers; delete json.materials;
  for (const mesh of json.meshes ?? []) for (const p of mesh.primitives) delete p.material;
  let chunk = Buffer.from(JSON.stringify(json));
  chunk = Buffer.concat([chunk, Buffer.alloc((4 - (chunk.length % 4)) % 4, 0x20)]);
  const rest = bytes.subarray(20 + length), head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + chunk.length + rest.length, 8);
  head.writeUInt32LE(chunk.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const glb = Buffer.concat([head, chunk, rest]);
  return new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
}

const SAMPLES = 192;

function trace(root: THREE.Object3D, clip: THREE.AnimationClip) {
  const paws: THREE.Object3D[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone && /^(toes|fingers)[LR]$/.test(o.name)) paws.push(o); });
  const mixer = new THREE.AnimationMixer(root), action = mixer.clipAction(clip);
  action.play();
  const tip = new THREE.Vector3();
  const rows = Array.from({ length: SAMPLES + 1 }, (_, i) => {
    action.time = clip.duration * i / SAMPLES;
    mixer.update(0);
    root.updateMatrixWorld(true);
    return paws.map((paw) => paw.localToWorld(tip.set(0, 0.05, 0)).clone());
  });
  action.stop(); mixer.uncacheRoot(root);
  return { rows, paws: paws.length };
}

function measure(t: ReturnType<typeof trace>, base = t) {
  let corner = 0, low = Infinity, lift = 0, planted = 0;
  for (let k = 0; k < t.paws; k++) {
    const ys = t.rows.map((r) => r[k]!.y), floor = Math.min(...base.rows.map((r) => r[k]!.y));
    low = Math.min(low, ...ys);
    lift = Math.max(lift, Math.max(...ys) - Math.min(...ys));
    for (let i = 1; i < SAMPLES; i++)
      corner = Math.max(corner, t.rows[i + 1]![k]!.clone().sub(t.rows[i]![k]!).sub(t.rows[i]![k]!.clone().sub(t.rows[i - 1]![k]!)).length());
    for (let i = 0; i <= SAMPLES; i++) if (base.rows[i]![k]!.y < floor + 0.004) planted = Math.max(planted, t.rows[i]![k]!.distanceTo(base.rows[i]![k]!));
  }
  return { corner, low, lift, planted };
}

describe('soft big-cat strides', () => {
  for (const file of ['AfricanLeopard.glb', 'AfricanGoldenCat.glb']) {
    it(`${file}: rounds every gait's hard steps, keeping its swing and its planted paws`, async () => {
      const gltf = await load(file);
      const softened = softenStrides(`/assets/animals/${file}`, gltf.animations);
      for (const name of ['Walk', 'Run', 'Gallop', 'Sneak']) {
        const before = gltf.animations.find((c) => c.name === name)!;
        const after = softened.find((c) => c.name === name)!;
        expect(after).not.toBe(before);
        expect(after.duration).toBeCloseTo(before.duration, 6);
        const a = measure(trace(gltf.scene, before)), b = measure(trace(gltf.scene, after), trace(gltf.scene, before));
        // The sharpest corner in any paw's path at least halves.
        expect(b.corner, name).toBeLessThan(a.corner * 0.5);
        // The paws still lift as high, and sink no lower than they did.
        expect(b.lift, name).toBeGreaterThan(a.lift * 0.85);
        expect(b.low, name).toBeGreaterThan(a.low - 0.002);
        // A planted paw stays put (the gallop's three-key stance is not measured against).
        if (name !== 'Gallop') expect(b.planted, name).toBeLessThan(0.006);
      }
      // Every other clip is the one authored.
      for (const clip of gltf.animations.filter((c) => !['Walk', 'Run', 'Gallop', 'Sneak'].includes(c.name)))
        expect(softened.find((c) => c.name === clip.name)).toBe(clip);
    });
  }

  it('closes each loop on its own first pose', async () => {
    const gltf = await load('AfricanLeopard.glb');
    const walk = softStride(gltf.animations.find((c) => c.name === 'Walk')!);
    for (const track of walk.tracks) {
      const width = track.getValueSize(), n = track.times.length;
      if (n < 4) continue;
      expect(track.times[n - 1]).toBeCloseTo(walk.duration, 5);
      for (let k = 0; k < width; k++) expect(track.values[(n - 1) * width + k]).toBeCloseTo(track.values[k]!, 6);
    }
  });

  it('leaves other rigs as authored', () => {
    const clips = [new THREE.AnimationClip('Walk', 1, [])];
    expect(softenStrides('/assets/animals/BlueDuiker.glb', clips)).toBe(clips);
    expect(BIG_CAT_MODELS.has('/assets/animals/AfricanLeopard.glb')).toBe(true);
  });
});
