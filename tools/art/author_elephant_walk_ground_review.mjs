// Review-only Walk floor-envelope correction for the pinned centred Asian elephant.
// No original source, skin, material, image, animation channel or BIN byte is rewritten.
// Usage: node tools/art/author_elephant_walk_ground_review.mjs INPUT.glb NEW_OUTPUT.glb
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AnimationMixer, LoopOnce, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, output] = process.argv.slice(2);
assert(source && output && source !== output, 'Expected pinned input and distinct output');
const bytes = readFileSync(source);
const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sourceSha256, '1053e07503a5861bf7b319123b8594ab0e3a280ea1633a50d7ced2ab3e66caa9');
assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
const jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const originalBin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
const rootIndex = doc.scenes[doc.scene].nodes[0];
assert.equal(doc.nodes[rootIndex].name, 'VANA_centered_review_root');
const walk = doc.animations.find(clip => clip.name === 'Walk');
assert(walk && !walk.channels.some(channel => channel.target.node === rootIndex));
const parsed = structuredClone(doc);
parsed.buffers[0].uri = `data:application/octet-stream;base64,${originalBin.toString('base64')}`;
delete parsed.images; delete parsed.textures; delete parsed.materials;
for (const mesh of parsed.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(parsed), '');
let skinned;
gltf.scene.traverse(node => { if (node.name === 'Object_7') skinned = node; });
assert(skinned?.isSkinnedMesh);
const clip = gltf.animations.find(clip => clip.name === 'Walk');
const root = gltf.scene.getObjectByName('VANA_centered_review_root');
assert(clip && root);
const base = doc.nodes[rootIndex].translation;
const mixer = new AnimationMixer(gltf.scene), action = mixer.clipAction(clip);
action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
const count = Math.ceil(clip.duration * 60);
const times = Float32Array.from({ length: count + 1 }, (_, i) => Math.fround(i * clip.duration / count));
const values = new Float32Array((count + 1) * 3);
const rawMinimums = [];
const point = new Vector3();
for (let i = 0; i <= count; i++) {
  action.reset().play(); mixer.setTime(times[i]); gltf.scene.updateMatrixWorld(true); skinned.skeleton.update();
  let minimum = Infinity;
  for (let vertex = 0; vertex < skinned.geometry.attributes.position.count; vertex++) {
    const y = skinned.getVertexPosition(vertex, point).applyMatrix4(skinned.matrixWorld).y;
    if (y < minimum) minimum = y;
  }
  assert(Number.isFinite(minimum)); rawMinimums.push(minimum);
  values.set([base[0], base[1] - minimum, base[2]], i * 3);
}
const correctionRange = [Math.min(...rawMinimums), Math.max(...rawMinimums)];
assert(Math.max(...rawMinimums.map(Math.abs)) < .12, 'Correction too large: inspect source before authoring');
assert(Math.abs(rawMinimums[0] - rawMinimums.at(-1)) < 1e-4, 'Walk floor correction does not close');

const pad = (4 - originalBin.length % 4) % 4;
let offset = originalBin.length + pad;
const chunks = [originalBin, Buffer.alloc(pad)];
function append(array, type, size) {
  const payload = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const view = doc.bufferViews.length;
  doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: payload.length });
  chunks.push(payload); offset += payload.length;
  const accessor = doc.accessors.length;
  doc.accessors.push({ bufferView: view, componentType: 5126, count: array.length / size, type,
    ...(type === 'SCALAR' ? { min: [array[0]], max: [array.at(-1)] } : {}) });
  return accessor;
}
const input = append(times, 'SCALAR', 1), value = append(values, 'VEC3', 3);
walk.channels.push({ sampler: walk.samplers.length, target: { node: rootIndex, path: 'translation' } });
walk.samplers.push({ input, output: value, interpolation: 'LINEAR' });
doc.buffers[0].byteLength = offset;
doc.asset.extras = { ...doc.asset.extras, vanaReviewOnly: true,
  groundWalkReview: { sourceSha256, method: '60 Hz sampled lowest skinned vertex to zero-height floor via centred wrapper Y translation only',
    rawMinimumRange: correctionRange, correctionRange: [-correctionRange[1], -correctionRange[0]],
    status: 'Floor-envelope correction only; not proof of stationary foot planting, anatomy, textured playback or release clearance.' } };
const raw = Buffer.from(JSON.stringify(doc));
const json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const binary = Buffer.concat(chunks);
const header = Buffer.from(bytes.subarray(0, 20));
header.writeUInt32LE(28 + json.length + binary.length, 8); header.writeUInt32LE(json.length, 12);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, json, binHeader, binary]);
writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, sourceSha256, sha256: createHash('sha256').update(result).digest('hex'),
  bytes: result.length, samples: times.length, rawMinimumRange: correctionRange,
  correctionRange: [-correctionRange[1], -correctionRange[0]], originalBinPreserved: true, reviewOnly: true }, null, 2));
