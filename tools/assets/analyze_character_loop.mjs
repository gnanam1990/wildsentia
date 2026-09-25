// Read-only numerical loop diagnosis; does not accept anatomy or modify clips.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AnimationMixer, LoopOnce, Vector3, Box3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const [source, meshName, clipName, rateText = '30'] = process.argv.slice(2);
const rate = Number(rateText);
assert(source && meshName && clipName && Number.isInteger(rate) && rate >= 1 && rate <= 120,
  'Usage: INPUT.glb EXACT_SKIN EXACT_CLIP [integer samples/sec 1..120]');
const bytes = readFileSync(source), length = bytes.readUInt32LE(12);
assert(bytes.toString('ascii', 0, 4) === 'glTF' && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length);
const document = JSON.parse(bytes.subarray(20, 20 + length));
assert(document.buffers.length === 1 && !document.buffers[0].uri);
document.buffers[0].uri = `data:application/octet-stream;base64,${bytes.subarray(28 + length, 28 + length + document.buffers[0].byteLength).toString('base64')}`;
delete document.images; delete document.textures; delete document.materials;
for (const mesh of document.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(document), '');
const matches = []; gltf.scene.traverse((o) => { if (o.name === meshName && o.isSkinnedMesh) matches.push(o); });
assert.equal(matches.length, 1); const mesh = matches[0];
const clip = gltf.animations.find((c) => c.name === clipName); assert(clip && clip.duration > .5, 'Expected named motion clip');
const mixer = new AnimationMixer(gltf.scene), action = mixer.clipAction(clip);
action.setLoop(LoopOnce, 1); action.clampWhenFinished = true;
const count = mesh.geometry.attributes.position.count, point = new Vector3();
function pose(time) {
  // Reset also unpauses a clamped endpoint before sampling an earlier phase.
  action.reset().play(); mixer.setTime(time);
  gltf.scene.updateMatrixWorld(true); mesh.skeleton.update();
  const positions = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
    assert(point.toArray().every(Number.isFinite)); point.toArray(positions, i * 3);
  }
  return positions;
}
const first = pose(0), bounds = new Box3();
for (let i = 0; i < count; i++) bounds.expandByPoint(point.fromArray(first, i * 3));
const height = bounds.max.y - bounds.min.y; assert(height > 0);
const dt = 1 / 120, next = pose(dt);
function compare(time) {
  const last = pose(time), previous = pose(time - dt);
  let maximum = 0, square = 0, velocitySquare = 0;
  for (let i = 0; i < count * 3; i += 3) {
    let distance2 = 0;
    for (let axis = 0; axis < 3; axis++) {
      const gap = last[i + axis] - first[i + axis]; distance2 += gap * gap;
      const speedGap = (last[i + axis] - previous[i + axis] - next[i + axis] + first[i + axis]) / dt;
      velocitySquare += speedGap * speedGap;
    }
    maximum = Math.max(maximum, Math.sqrt(distance2)); square += distance2;
  }
  return { seconds: time, maxGapInBodyHeights: maximum / height, rmsGapInBodyHeights: Math.sqrt(square / count) / height,
    rmsVelocityGapInBodyHeightsPerSecond: Math.sqrt(velocitySquare / count) / height };
}
const candidates = [];
for (let frame = Math.ceil(.5 * rate); frame / rate < clip.duration; frame++) candidates.push(compare(frame / rate));
const endpoint = compare(clip.duration);
const ranked = [...candidates, endpoint].sort((a, b) => a.rmsGapInBodyHeights - b.rmsGapInBodyHeights);
console.log(JSON.stringify({ sourceSha256: createHash('sha256').update(bytes).digest('hex'), mesh: meshName, clip: clipName,
  clipDuration: clip.duration, samplesPerSecond: rate, derivativeWindowSeconds: dt, initialHeight: height,
  scope: 'Sampled vertex loop position and finite-difference velocity; not gait or contact acceptance',
  endpoint, bestCandidates: ranked.slice(0, 8), finalWindow: candidates.filter((c) => c.seconds >= clip.duration - .2) }, null, 2));
