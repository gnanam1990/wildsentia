import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationMixer, LoopOnce, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { visualFor } from '../src/species.js';
import { expectRegeneratedGlb } from './glbRegeneration.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = join(root, 'tools/assets/sources/review/elephant-2026-09-24/recovered/AsianElephantCenteredReview.glb');
const derived = join(root, 'tools/assets/sources/review/elephant-2026-09-24/recovered/AsianElephantDrinkingContactReview.glb');
const regularized = join(root, 'tools/assets/sources/review/elephant-2026-09-24/recovered/AsianElephantDrinkingContactRegularizedReview.glb');
const surface = join(root, 'tools/assets/sources/review/elephant-2026-09-24/recovered/AsianElephantDrinkingSurfaceReview.glb');
const tool = join(root, 'tools/assets/elephant/author_drinking_contact_review.mjs');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function document(bytes: Buffer) {
  expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  return { json: JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()), jsonLength };
}
async function loadGeometry(bytes: Buffer) {
  const { json, jsonLength } = document(bytes), probe = structuredClone(json);
  const binary = bytes.subarray(28 + jsonLength, 28 + jsonLength + probe.buffers[0].byteLength);
  probe.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
  delete probe.images; delete probe.textures; delete probe.materials;
  for (const mesh of probe.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  globalThis.ProgressEvent ??= class { constructor(public type: string, init: object) { Object.assign(this, init); } } as typeof ProgressEvent;
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(probe), '');
  const byName = new Map<string, import('three').Object3D>();
  gltf.scene.traverse(node => byName.set(node.name, node));
  return { gltf, byName, mesh: byName.get('Object_7') as import('three').SkinnedMesh };
}

describe('review-only Asian elephant drinking contact derivative', () => {
  it('is deterministic and append-only for the licensed source rig and four clips', () => {
    const before = readFileSync(source), after = readFileSync(derived);
    expect(sha(before)).toBe('1053e07503a5861bf7b319123b8594ab0e3a280ea1633a50d7ced2ab3e66caa9');
    expect(sha(after)).toBe('2abcdd7e4f81528e917ef049db0e1ebd82eb4252bf428e4ee362a339697964a6');
    const a = document(before), b = document(after);
    const beforeBin = before.subarray(28 + a.jsonLength, 28 + a.jsonLength + a.json.buffers[0].byteLength);
    const afterBin = after.subarray(28 + b.jsonLength, 28 + b.jsonLength + a.json.buffers[0].byteLength);
    expect(afterBin.equals(beforeBin)).toBe(true);
    for (const key of ['nodes', 'meshes', 'skins', 'materials', 'textures', 'images'])
      expect(b.json[key]).toEqual(a.json[key]);
    expect(b.json.animations.slice(0, 4)).toEqual(a.json.animations);
    expect(b.json.bufferViews.slice(0, a.json.bufferViews.length)).toEqual(a.json.bufferViews);
    expect(b.json.accessors.slice(0, a.json.accessors.length)).toEqual(a.json.accessors);
    expect(b.json.animations[4].name).toBe('DrinkingContactReview');
    expect(b.json.animations[4].channels).toHaveLength(153);
    expect(b.json.asset.extras.vanaReviewOnly).toBe(true);
    expect(b.json.asset.extras.drinkingContactReview.sourceSha256).toBe(sha(before));
    for (const key of ['author', 'license', 'source', 'title']) expect(b.json.asset.extras[key]).toEqual(a.json.asset.extras[key]);
    expect(visualFor('elephant').model?.file).toBe('/assets/animals/ElephantWalking.glb');
    const scratch = mkdtempSync(join(tmpdir(), 'vana-elephant-drink-'));
    try {
      const output = join(scratch, 'review.glb');
      const run = spawnSync(process.execPath, [tool, source, output], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expectRegeneratedGlb(readFileSync(output), after);
      expect(spawnSync(process.execPath, [tool, source, output]).status).not.toBe(0);
      expectRegeneratedGlb(readFileSync(output), after);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it('replays sampled trunk-water and trunk-jaw contacts without moving the skin or corrupting feet', async () => {
    const a = await loadGeometry(readFileSync(source)), b = await loadGeometry(readFileSync(derived));
    expect(b.mesh?.isSkinnedMesh).toBe(true);
    expect(b.mesh.skeleton.bones).toHaveLength(a.mesh.skeleton.bones.length);
    expect(b.mesh.geometry.attributes.position.count).toBe(a.mesh.geometry.attributes.position.count);
    const newClip = b.gltf.animations.find(clip => clip.name === 'DrinkingContactReview');
    expect(newClip).toBeDefined();
    const mixer = new AnimationMixer(b.gltf.scene), action = mixer.clipAction(newClip!);
    action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
    const tip = b.byName.get('bone27_093')!, jaw = b.byName.get('root3_096')!;
    const distances: number[] = [], heights: number[] = [];
    for (const time of [0, .28, .75, 1.37, 1.52, 2.75, newClip!.duration]) {
      action.reset().play(); mixer.setTime(time); b.gltf.scene.updateMatrixWorld(true); b.mesh.skeleton.update();
      const p = tip.getWorldPosition(new Vector3()), q = jaw.getWorldPosition(new Vector3());
      distances.push(p.distanceTo(q)); heights.push(p.y);
      for (let vertex = 0; vertex < b.mesh.geometry.attributes.position.count; vertex += 43) {
        const v = b.mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(b.mesh.matrixWorld);
        expect(v.toArray().every(Number.isFinite)).toBe(true);
      }
    }
    expect(Math.abs(heights[1]!)).toBeLessThan(.01);
    expect(distances[3]!).toBeLessThan(.02);
    expect(distances[4]!).toBeLessThan(.02);
    expect(heights.at(-1)).toBeCloseTo(heights[0]!, 4);
    expect(distances.at(-1)).toBeCloseTo(distances[0]!, 4);
    // Existing source Spraying has the same body/feet at water and lifted poses.
    const sourceClip = a.gltf.animations.find(clip => clip.name === 'SprayWater')!;
    const sourceMixer = new AnimationMixer(a.gltf.scene), sourceAction = sourceMixer.clipAction(sourceClip);
    sourceAction.setLoop(LoopOnce, 1); sourceAction.clampWhenFinished = true; sourceAction.play();
    for (const [reviewTime, sourceTime] of [[.28, .28], [1.37, sourceClip.duration]] as const) {
      sourceAction.reset().play(); sourceMixer.setTime(sourceTime);
      action.reset().play(); mixer.setTime(reviewTime);
      a.gltf.scene.updateMatrixWorld(true); b.gltf.scene.updateMatrixWorld(true);
      for (const boneName of ['Quadruped_Skeleton_BLFootRoot_013', 'Quadruped_Skeleton_BRFootRoot_021',
        'Quadruped_Skeleton_LFootRoot_045', 'Quadruped_Skeleton_RFootRoot_054']) {
        const before = a.byName.get(boneName), after = b.byName.get(boneName);
        expect(before).toBeDefined(); expect(after).toBeDefined();
        expect(before!.getWorldPosition(new Vector3()).distanceTo(after!.getWorldPosition(new Vector3()))).toBeLessThan(.001);
      }
    }
  }, 15000);

  it('regenerates the distributed-curl alternative with source-preserving water and jaw contacts', async () => {
    const before = readFileSync(source), after = readFileSync(regularized);
    expect(sha(after)).toBe('9c867bb75eee132b92f73ea65c38fda79b8b2d33cd7ff7667e49ba756ce3058d');
    const a = document(before), b = document(after);
    expect(after.subarray(28 + b.jsonLength, 28 + b.jsonLength + a.json.buffers[0].byteLength)
      .equals(before.subarray(28 + a.jsonLength, 28 + a.jsonLength + a.json.buffers[0].byteLength))).toBe(true);
    expect(b.json.animations.slice(0, 4)).toEqual(a.json.animations);
    expect(b.json.skins).toEqual(a.json.skins);
    expect(b.json.animations[4].name).toBe('DrinkingContactRegularizedReview');
    const scratch = mkdtempSync(join(tmpdir(), 'vana-elephant-drink-regularized-'));
    try {
      const output = join(scratch, 'review.glb');
      const run = spawnSync(process.execPath, [tool, source, output, 'water-lift'], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expectRegeneratedGlb(readFileSync(output), after);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    const model = await loadGeometry(after);
    const clip = model.gltf.animations.find(clip => clip.name === 'DrinkingContactRegularizedReview')!;
    const mixer = new AnimationMixer(model.gltf.scene), action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
    const tip = model.byName.get('bone27_093')!, jaw = model.byName.get('root3_096')!;
    const sample = (time: number) => {
      action.reset().play(); mixer.setTime(time); model.gltf.scene.updateMatrixWorld(true);
      const p = tip.getWorldPosition(new Vector3()), q = jaw.getWorldPosition(new Vector3());
      return { y: p.y, distance: p.distanceTo(q) };
    };
    expect(Math.abs(sample(.28).y)).toBeLessThan(.01);
    expect(sample(1.18).distance).toBeLessThan(.02);
    expect(sample(1.33).distance).toBeLessThan(.02);
    expect(sample(clip.duration).y).toBeCloseTo(sample(0).y, 4);
  }, 15000);

  it('regenerates the surface-target candidate without promoting it and measures actual skinned-mesh proximity', async () => {
    const before = readFileSync(source), after = readFileSync(surface);
    expect(sha(after)).toBe('a9a77d7f3d7573bfe271079b26ee7e667a1663b3c51a13025e8686eccd89915e');
    const a = document(before), b = document(after);
    expect(after.subarray(28 + b.jsonLength, 28 + b.jsonLength + a.json.buffers[0].byteLength)
      .equals(before.subarray(28 + a.jsonLength, 28 + a.jsonLength + a.json.buffers[0].byteLength))).toBe(true);
    for (const key of ['nodes', 'meshes', 'skins', 'materials', 'textures', 'images'])
      expect(b.json[key]).toEqual(a.json[key]);
    expect(b.json.animations.slice(0, 4)).toEqual(a.json.animations);
    expect(b.json.animations[4].name).toBe('DrinkingSurfaceReview');
    expect(b.json.asset.extras.vanaReviewOnly).toBe(true);
    expect(visualFor('elephant').model?.file).toBe('/assets/animals/ElephantWalking.glb');
    const scratch = mkdtempSync(join(tmpdir(), 'vana-elephant-drink-surface-'));
    try {
      const output = join(scratch, 'review.glb');
      const run = spawnSync(process.execPath, [tool, source, output, 'surface-lift'], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expectRegeneratedGlb(readFileSync(output), after);
    } finally { rmSync(scratch, { recursive: true, force: true }); }

    const model = await loadGeometry(after);
    const clip = model.gltf.animations.find(c => c.name === 'DrinkingSurfaceReview')!;
    const mixer = new AnimationMixer(model.gltf.scene), action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
    const mesh = model.mesh, indices = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
    function regionDistance(time: number) {
      action.reset().play(); mixer.setTime(time); model.gltf.scene.updateMatrixWorld(true); mesh.skeleton.update();
      const distal: Vector3[] = [], jaw: Vector3[] = [];
      for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        let distalWeight = 0, jawWeight = 0;
        for (let k = 0; k < 4; k++) {
          const bone = indices.getComponent(i, k), weight = weights.getComponent(i, k);
          if (bone >= 57 && bone <= 60) distalWeight += weight;
          if (bone >= 61 && bone <= 63) jawWeight += weight;
        }
        if (distalWeight >= .7) distal.push(mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
        if (jawWeight >= .7) jaw.push(mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
      }
      expect(distal.length).toBe(224); expect(jaw.length).toBe(62);
      return Math.min(...distal.flatMap(p => jaw.map(q => p.distanceTo(q))));
    }
    expect(regionDistance(1.18)).toBeLessThan(.01);
    expect(regionDistance(1.33)).toBeLessThan(.01);
    const tip = model.byName.get('bone27_093')!;
    action.reset().play(); mixer.setTime(0); model.gltf.scene.updateMatrixWorld(true);
    const initial = tip.getWorldPosition(new Vector3());
    action.reset().play(); mixer.setTime(.28); model.gltf.scene.updateMatrixWorld(true);
    expect(Math.abs(tip.getWorldPosition(new Vector3()).y)).toBeLessThan(.01);
    const feet = ['Quadruped_Skeleton_BLFootRoot_013', 'Quadruped_Skeleton_BRFootRoot_021',
      'Quadruped_Skeleton_LFootRoot_045', 'Quadruped_Skeleton_RFootRoot_054'];
    const grounded = feet.map(name => model.byName.get(name)!.getWorldPosition(new Vector3()));
    action.reset().play(); mixer.setTime(1.18); model.gltf.scene.updateMatrixWorld(true);
    feet.forEach((name, index) => expect(model.byName.get(name)!.getWorldPosition(new Vector3())
      .distanceTo(grounded[index]!)).toBeLessThan(.001));
    action.reset().play(); mixer.setTime(clip.duration); model.gltf.scene.updateMatrixWorld(true);
    expect(tip.getWorldPosition(new Vector3()).distanceTo(initial)).toBeLessThan(.0001);
  }, 15000);
});
