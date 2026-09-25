// Source-preserving Three.js skinning audit. No browser, texture network requests, or animation edits.
// Usage: node audit_character_motion.mjs SOURCE.glb CANDIDATE.glb EXACT_MESH [SAMPLES_PER_SECOND] [isolated|pruned|walk-loop]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AnimationMixer, Box3, Vector3, LoopOnce } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, candidate, meshName, rateText = '12', mode = 'isolated'] = process.argv.slice(2);
const rate = Number(rateText);
if (!source || !candidate || !meshName || !Number.isInteger(rate) || rate < 1 || rate > 60 || !['isolated', 'pruned', 'walk-loop'].includes(mode))
  throw new Error('Usage: SOURCE.glb CANDIDATE.glb EXACT_MESH [integer samples/sec 1..60] [isolated|pruned|walk-loop]');
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
async function load(path) {
  const bytes = readFileSync(path);
  assert(bytes.toString('ascii', 0, 4) === 'glTF' && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length);
  const length = bytes.readUInt32LE(12), original = JSON.parse(bytes.subarray(20, 20 + length));
  assert(original.buffers.length === 1 && !original.buffers[0].uri, 'Expected embedded binary');
  const document = structuredClone(original);
  const bin = bytes.subarray(28 + length, 28 + length + original.buffers[0].byteLength);
  document.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
  delete document.images; delete document.textures; delete document.materials;
  for (const mesh of document.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(document), '');
  const matches = [], rendered = [];
  gltf.scene.traverse((object) => {
    if (object.isMesh) rendered.push(object.name);
    if (object.isSkinnedMesh && object.name === meshName) matches.push(object);
  });
  assert.equal(matches.length, 1, 'Expected one named skin');
  return { original, gltf, mesh: matches[0], rendered, bin, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const a = await load(source), b = await load(candidate);
let correctionStart;
if (mode === 'walk-loop') {
  correctionStart = b.original.asset.extras.walkLoopReview.correctionStart;
  const duration = a.gltf.animations.find((clip) => clip.name === 'Walk').duration;
  assert(Math.abs(correctionStart - (duration - .3)) < 1e-6, 'Only the final 0.3 s may be authored');
  assert.deepEqual(b.bin.subarray(0, a.bin.length), a.bin, 'Original binary payload must remain unchanged');
  assert.deepEqual(a.original.skins, b.original.skins);
  assert.deepEqual(a.original.materials, b.original.materials);
  assert.deepEqual(a.original.animations.filter((clip) => clip.name !== 'Walk'), b.original.animations.filter((clip) => clip.name !== 'Walk'));
}
if (mode === 'isolated') {
  assert.deepEqual(a.original.animations, b.original.animations, 'Isolation must not modify animation channels');
  assert.deepEqual(a.original.skins, b.original.skins, 'Isolation must preserve inverse bind data');
  assert.deepEqual(a.original.images, b.original.images, 'Isolation must preserve images');
  assert.deepEqual(a.original.materials, b.original.materials, 'Isolation must preserve material metadata');
} else if (mode === 'pruned') {
  assert.deepEqual(b.original.materials, [a.original.materials[0]], 'Pruning must preserve selected material');
  const imageBytes = (model) => { const view = model.original.bufferViews[model.original.images[0].bufferView];
    return model.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength); };
  assert.deepEqual(imageBytes(a), imageBytes(b), 'Selected image bytes changed');
}
assert.deepEqual(a.gltf.animations.map((clip) => [clip.name, clip.duration]), b.gltf.animations.map((clip) => [clip.name, clip.duration]), 'Clip identity/duration must not change');
assert.deepEqual(b.rendered, [meshName], 'Candidate must draw only the chosen elephant');
const count = a.mesh.geometry.attributes.position.count;
assert.equal(count, b.mesh.geometry.attributes.position.count);
const p = new Vector3(), q = new Vector3(), results = [];
let checkedVertices = 0;
let maximumOutsideTailDifference = 0, maximumAuthoredDifferenceInBodyHeights = 0;
for (let index = 0; index < a.gltf.animations.length; index++) {
  const clip = a.gltf.animations[index], other = b.gltf.animations[index];
  const mixers = [new AnimationMixer(a.gltf.scene), new AnimationMixer(b.gltf.scene)];
  for (const [i, mixer] of mixers.entries()) {
    const action = mixer.clipAction(i === 0 ? clip : other);
    action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
  }
  const frames = Math.ceil(clip.duration * rate), union = new Box3();
  let first = null, last = null, smallestHeight = Infinity, largestHeight = 0, changedFromFirst = 0;
  let maximumLoopGap = 0, squaredLoopGaps = 0, maximumLoopGapVertex = -1;
  let initialCandidate = null;
  for (let frame = 0; frame <= frames; frame++) {
    const time = Math.min(clip.duration, frame / rate);
    mixers.forEach((mixer) => mixer.setTime(time));
    for (const model of [a, b]) { model.gltf.scene.updateMatrixWorld(true); model.mesh.skeleton.update(); }
    const bounds = new Box3();
    for (let vertex = 0; vertex < count; vertex++) {
      a.mesh.getVertexPosition(vertex, p).applyMatrix4(a.mesh.matrixWorld);
      b.mesh.getVertexPosition(vertex, q).applyMatrix4(b.mesh.matrixWorld);
      assert(p.toArray().every(Number.isFinite) && q.toArray().every(Number.isFinite), 'Non-finite skinned vertex');
      if (mode === 'walk-loop' && clip.name === 'Walk') {
        const difference = p.distanceTo(q);
        const height = first ? first.max.y - first.min.y : 1;
        if (time <= correctionStart) {
          maximumOutsideTailDifference = Math.max(maximumOutsideTailDifference, difference);
          assert(difference <= height * 1e-6, `Unexpected change before Walk correction window: ${time}s`);
        } else {
          maximumAuthoredDifferenceInBodyHeights = Math.max(maximumAuthoredDifferenceInBodyHeights, difference / height);
          assert(difference < height * .1, 'Tail correction exceeds 10% of starting height; reject this review candidate');
        }
      } else assert(p.equals(q), `${clip.name} ${time}s vertex ${vertex}: isolation changed pose`);
      if (frame === 0) {
        initialCandidate ??= new Float64Array(count * 3); q.toArray(initialCandidate, vertex * 3);
      }
      else if (Math.abs(q.x - initialCandidate[vertex * 3]) + Math.abs(q.y - initialCandidate[vertex * 3 + 1]) + Math.abs(q.z - initialCandidate[vertex * 3 + 2]) > 1e-6) changedFromFirst++;
      if (frame === frames) {
        const gap = Math.hypot(q.x - initialCandidate[vertex * 3], q.y - initialCandidate[vertex * 3 + 1], q.z - initialCandidate[vertex * 3 + 2]);
        squaredLoopGaps += gap * gap;
        if (gap > maximumLoopGap) { maximumLoopGap = gap; maximumLoopGapVertex = vertex; }
      }
      bounds.expandByPoint(q); checkedVertices++;
    }
    union.union(bounds); first ??= bounds.clone(); last = bounds;
    const height = bounds.max.y - bounds.min.y;
    smallestHeight = Math.min(smallestHeight, height); largestHeight = Math.max(largestHeight, height);
  }
  results.push({ clip: clip.name, seconds: clip.duration, samples: frames + 1,
    firstBounds: { min: first.min.toArray(), max: first.max.toArray() },
    lastBounds: { min: last.min.toArray(), max: last.max.toArray() },
    unionBounds: { min: union.min.toArray(), max: union.max.toArray() },
    smallestHeight, largestHeight, changedVertexSamples: changedFromFirst,
    loopEndpointGap: { maximum: maximumLoopGap, rms: Math.sqrt(squaredLoopGaps / count), vertex: maximumLoopGapVertex,
      maximumAsFractionOfInitialHeight: maximumLoopGap / (first.max.y - first.min.y) } });
  mixers.forEach((mixer, i) => { mixer.stopAllAction(); mixer.uncacheRoot(i === 0 ? a.gltf.scene : b.gltf.scene); });
}
console.log(JSON.stringify({ sourceSha256: a.sha256, candidateSha256: b.sha256, mesh: meshName,
  visibleMeshes: b.rendered, vertices: count, skinJoints: b.mesh.skeleton.bones.length,
  samplesPerSecond: rate, checkedVertices, exactPoseAgreement: mode !== 'walk-loop', comparisonMode: mode,
  ...(mode === 'walk-loop' ? { maximumOutsideTailDifference, maximumAuthoredDifferenceInBodyHeights,
    preservedOutsideWalkTailWithinTolerance: true, correctionStart } : {}),
  scope: 'Sampled Three.js vertex comparison and finite bounds only; not anatomical, gait, lifecycle or browser acceptance', results }, null, 2));
