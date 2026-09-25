import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationMixer, Box3, LoopOnce, Texture, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { AnimalLayer } from '../src/animals.js';
import { visualFor } from '../src/species.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = join(root, 'docs/art-review/elephant-2026-09-24/recovered/AsianElephantLoopReview.glb');
const centered = join(root, 'docs/art-review/elephant-2026-09-24/recovered/AsianElephantCenteredReview.glb');
const tool = join(root, 'tools/assets/elephant/normalize_centered_review.mjs');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function document(bytes: Buffer) {
  expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  return { jsonLength, json: JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()) };
}
async function loadGeometry(bytes: Buffer) {
  const { jsonLength, json } = document(bytes);
  const probe = structuredClone(json);
  const binary = bytes.subarray(28 + jsonLength, 28 + jsonLength + probe.buffers[0].byteLength);
  probe.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
  delete probe.images; delete probe.textures; delete probe.materials;
  for (const mesh of probe.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  globalThis.ProgressEvent ??= class { constructor(public type: string, init: object) { Object.assign(this, init); } } as typeof ProgressEvent;
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(probe), '');
  const matches: import('three').SkinnedMesh[] = [];
  gltf.scene.traverse(node => { if (node.name === 'Object_7' && (node as import('three').SkinnedMesh).isSkinnedMesh)
    matches.push(node as import('three').SkinnedMesh); });
  expect(matches).toHaveLength(1);
  return { gltf, mesh: matches[0]! };
}

describe('review-only Asian elephant root normalization', () => {
  it('is deterministic, non-destructive and retains all source rig/clip/attribution data', () => {
    const before = readFileSync(source), after = readFileSync(centered);
    expect(sha(before)).toBe('6e42ca4efb52f818317955ba1c85f1efaf5bd995dbfbf2c4889e4c1d6500be6c');
    expect(sha(after)).toBe('1053e07503a5861bf7b319123b8594ab0e3a280ea1633a50d7ced2ab3e66caa9');
    const a = document(before), b = document(after);
    expect(after.subarray(20 + b.jsonLength).equals(before.subarray(20 + a.jsonLength))).toBe(true);
    for (const key of ['buffers', 'bufferViews', 'accessors', 'meshes', 'skins', 'animations', 'materials', 'textures', 'images'])
      expect(b.json[key]).toEqual(a.json[key]);
    for (const key of ['author', 'license', 'source', 'title']) expect(b.json.asset.extras[key]).toBe(a.json.asset.extras[key]);
    expect(b.json.asset.extras.vanaReviewOnly).toBe(true);
    expect(b.json.asset.extras.centeredRootReview.sourceSha256).toBe(sha(before));
    expect(b.json.nodes.slice(0, a.json.nodes.length)).toEqual(a.json.nodes);
    expect(b.json.nodes).toHaveLength(a.json.nodes.length + 1);
    expect(b.json.scenes[0].nodes).toEqual([a.json.nodes.length]);
    expect(visualFor('elephant').model?.file).toBe('/assets/animals/ElephantWalking.glb');
    const scratch = mkdtempSync(join(tmpdir(), 'vana-elephant-center-'));
    try {
      const output = join(scratch, 'centered.glb');
      const run = spawnSync(process.execPath, [tool, source, output], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(output).equals(after)).toBe(true);
      expect(spawnSync(process.execPath, [tool, source, output]).status).not.toBe(0);
      expect(readFileSync(output).equals(after)).toBe(true);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it('centres the exact AnimalLayer bind box and transforms every sampled skinned pose without deformation', async () => {
    const before = readFileSync(source), after = readFileSync(centered);
    const { json } = document(after);
    const { sourceBounds, unitScale } = json.asset.extras.centeredRootReview;
    const a = await loadGeometry(before), b = await loadGeometry(after);
    const box = new Box3().setFromObject(b.gltf.scene);
    const mid = box.getCenter(new Vector3()), height = box.max.y - box.min.y;
    expect(mid.x).toBeCloseTo(0, 5); expect(mid.z).toBeCloseTo(0, 5);
    expect(box.min.y).toBeCloseTo(0, 5); expect(height).toBeCloseTo(1, 5);
    // Actual AnimalLayer sizing uses this same box and 2.7-m species height.
    const animalScale = visualFor('elephant').heightM / height;
    expect(animalScale).toBeCloseTo(2.7, 5);
    expect(mid.x * animalScale).toBeCloseTo(0, 5);
    expect(mid.z * animalScale).toBeCloseTo(0, 5);
    expect(box.min.y * animalScale).toBeCloseTo(0, 5);
    expect(a.gltf.animations.map(clip => [clip.name, clip.duration]))
      .toEqual(b.gltf.animations.map(clip => [clip.name, clip.duration]));
    const p = new Vector3(), q = new Vector3();
    for (let index = 0; index < a.gltf.animations.length; index++) {
      const clips = [a.gltf.animations[index]!, b.gltf.animations[index]!];
      const mixers = [new AnimationMixer(a.gltf.scene), new AnimationMixer(b.gltf.scene)];
      mixers.forEach((mixer, i) => { const action = mixer.clipAction(clips[i]!);
        action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play(); });
      for (const fraction of [0, .25, .5, .75, 1]) {
        const seconds = clips[0]!.duration * fraction;
        mixers.forEach(mixer => mixer.setTime(seconds));
        for (const model of [a, b]) { model.gltf.scene.updateMatrixWorld(true); model.mesh.skeleton.update(); }
        for (let vertex = 0; vertex < a.mesh.geometry.attributes.position.count; vertex++) {
          a.mesh.getVertexPosition(vertex, p).applyMatrix4(a.mesh.matrixWorld);
          b.mesh.getVertexPosition(vertex, q).applyMatrix4(b.mesh.matrixWorld);
          expect(q.x).toBeCloseTo((p.x - (sourceBounds.min[0] + sourceBounds.max[0]) / 2) * unitScale, 4);
          expect(q.y).toBeCloseTo((p.y - sourceBounds.min[1]) * unitScale, 4);
          expect(q.z).toBeCloseTo((p.z - (sourceBounds.min[2] + sourceBounds.max[2]) / 2) * unitScale, 4);
        }
      }
      mixers.forEach(mixer => mixer.stopAllAction());
    }
  }, 15000);

  it('places the review rig around the authoritative animal coordinate in the actual AnimalLayer path', async () => {
    const geometry = await loadGeometry(readFileSync(centered));
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(geometry.gltf as never);
    try {
      const layer = new AnimalLayer(new Texture());
      const animal = { id: 'elephant-review', speciesId: 'elephant', patchId: 0,
        position: { x: 20, z: 30, heading: 0 }, state: 'resting', currentGoal: 'rest',
        drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 0 } };
      const living = new Map([[animal.id, animal]]);
      layer.sync(living, 0, animal.id, { x: 20, z: 30 });
      await vi.waitFor(() => expect(layer.pendingModelCount).toBe(0), { timeout: 1000, interval: 2 });
      layer.sync(living, 1, animal.id, { x: 20, z: 30 });
      const rig = layer.root.getObjectByName(animal.id)!;
      rig.updateMatrixWorld(true);
      const mesh = rig.getObjectByName('Object_7')!;
      const box = new Box3().setFromObject(mesh);
      const center = box.getCenter(new Vector3());
      expect(center.x).toBeCloseTo(20, 1);
      expect(center.z).toBeCloseTo(30, 1);
      expect(box.min.y).toBeCloseTo(0, 1);
      expect(box.max.y - box.min.y).toBeCloseTo(2.7, 1);
      layer.sync(new Map(), 2, null, { x: 20, z: 30 });
    } finally { load.mockRestore(); }
  }, 10000);
});
