// Make a bounded, review-only calf-proportion derivative of the pinned local
// tuskless Asian-elephant rig. No new source, texture, skeleton or clip is invented.
// Usage: node tools/assets/elephant/build_calf_review.mjs NEW_OUTPUT.glb
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Matrix4, Vector3 } from 'three';

const input = fileURLToPath(new URL('../../../packages/client/public/assets/animals/AsianElephantAdultFemale.glb', import.meta.url));
const output = process.argv[2];
assert(output && process.argv.length === 3, 'Provide one new output GLB path');
const bytes = readFileSync(input);
const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sourceSha256, '4b2259f653ca329b0c61e69a155f312b97555d92b66506731edfcec5fb54de03');
assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
const jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
assert.equal(doc.asset.extras.license, 'CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)');
assert.equal(doc.meshes.length, 1);
assert.equal(doc.skins.length, 1);
const binary = Buffer.from(bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength));

// Parse a geometry-only copy so Node does not need browser image decoding. The
// source document and every embedded texture/animation byte stay intact below.
const parsed = structuredClone(doc);
parsed.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
delete parsed.images; delete parsed.textures; delete parsed.materials;
for (const mesh of parsed.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(parsed), '');
gltf.scene.updateMatrixWorld(true);
let mesh;
gltf.scene.traverse(node => { if (node.isSkinnedMesh) mesh = node; });
assert(mesh, 'Expected one skinned elephant mesh');
mesh.skeleton.update();
const attributes = mesh.geometry.attributes;
const positionAccessor = doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION];
const positionView = doc.bufferViews[positionAccessor.bufferView];
assert.equal(positionAccessor.componentType, 5126);
assert.equal(positionAccessor.type, 'VEC3');
assert.equal(positionAccessor.count, attributes.position.count);
assert.equal(positionView.byteStride, undefined);
const positionStart = (positionView.byteOffset ?? 0) + (positionAccessor.byteOffset ?? 0);
const invMeshWorld = mesh.matrixWorld.clone().invert();
const weighted = new Matrix4(), jointMatrix = new Matrix4(), effective = new Matrix4();
const rest = new Vector3(), target = new Vector3(), local = new Vector3();
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let changed = 0, maximumWorldDelta = 0, trunkVertices = 0;
for (let i = 0; i < positionAccessor.count; i++) {
  rest.copy(mesh.getVertexPosition(i, rest)).applyMatrix4(mesh.matrixWorld);
  target.copy(rest);
  // Young Asian elephants have a more compact torso and a relatively larger
  // head. This is deliberately modest: it is not a claim of measured anatomy.
  if (target.x > -0.02) target.x -= (target.x + 0.02) * 0.10 * smoothstep(-0.02, 0.15, target.x);
  const head = (1 - smoothstep(-0.20, -0.02, rest.x)) * smoothstep(0.35, 0.55, rest.y)
    * (1 - smoothstep(-0.20, -0.05, rest.z));
  target.x += (rest.x + 0.27) * 0.16 * head;
  target.y += (rest.y - 0.70) * 0.12 * head;
  target.z += (rest.z + 0.37) * 0.16 * head;
  let trunk = 0;
  for (let k = 0; k < 4; k++) {
    const joint = attributes.skinIndex.getComponent(i, k);
    const node = doc.skins[0].joints[joint];
    if (node >= 84 && node <= 100) trunk += attributes.skinWeight.getComponent(i, k);
  }
  if (trunk > 0.25) trunkVertices++;

  weighted.elements.fill(0);
  for (let k = 0; k < 4; k++) {
    const joint = attributes.skinIndex.getComponent(i, k);
    const weight = attributes.skinWeight.getComponent(i, k);
    if (weight <= 0) continue;
    jointMatrix.multiplyMatrices(mesh.skeleton.bones[joint].matrixWorld, mesh.skeleton.boneInverses[joint]);
    for (let c = 0; c < 16; c++) weighted.elements[c] += jointMatrix.elements[c] * weight;
  }
  effective.multiplyMatrices(mesh.bindMatrixInverse, weighted).multiply(mesh.bindMatrix);
  assert(Math.abs(effective.determinant()) > 1e-12, `Non-invertible skin transform at vertex ${i}`);
  local.copy(target).applyMatrix4(invMeshWorld).applyMatrix4(effective.invert());
  assert([local.x, local.y, local.z].every(Number.isFinite), `Non-finite calf position at vertex ${i}`);
  const delta = target.distanceTo(rest);
  if (delta > 1e-5) changed++;
  maximumWorldDelta = Math.max(maximumWorldDelta, delta);
  for (let c = 0; c < 3; c++) {
    const value = local.getComponent(c);
    binary.writeFloatLE(value, positionStart + i * 12 + c * 4);
    min[c] = Math.min(min[c], value); max[c] = Math.max(max[c], value);
  }
}
assert(changed > 1000 && trunkVertices > 250 && maximumWorldDelta < 0.25);
positionAccessor.min = min; positionAccessor.max = max;
// Shorten the distal trunk skeleton itself, including every authored translation
// sample. Leaving adult-length joints under shortened surface vertices made a
// conspicuous hook in Walk. Keep the proximal head-to-trunk joint (86) intact.
const trunkScale = 0.72;
const distalNodes = new Set(Array.from({ length: 14 }, (_, i) => i + 87));
for (const index of distalNodes) {
  const translation = doc.nodes[index].translation;
  assert(translation?.length === 3, `Missing distal trunk joint ${index}`);
  doc.nodes[index].translation = translation.map(value => value * trunkScale);
}
let retargetedChannels = 0;
for (const animation of doc.animations) for (const channel of animation.channels) {
  if (channel.target.path !== 'translation' || !distalNodes.has(channel.target.node)) continue;
  const accessor = doc.accessors[animation.samplers[channel.sampler].output];
  const view = doc.bufferViews[accessor.bufferView];
  assert.equal(accessor.componentType, 5126);
  assert.equal(accessor.type, 'VEC3');
  assert.equal(view.byteStride, undefined);
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  for (let sample = 0; sample < accessor.count; sample++) for (let component = 0; component < 3; component++) {
    const offset = start + sample * 12 + component * 4;
    binary.writeFloatLE(binary.readFloatLE(offset) * trunkScale, offset);
  }
  if (accessor.min) accessor.min = accessor.min.map(value => value * trunkScale);
  if (accessor.max) accessor.max = accessor.max.map(value => value * trunkScale);
  retargetedChannels++;
}
assert(retargetedChannels >= 4, 'Expected trunk motion in the retained source clips');
doc.asset.extras = { ...doc.asset.extras, vanaInterimLive: false, vanaReviewOnly: true,
  calfProportionReview: { sourceSha256, changedVertices: changed, trunkVertices,
    retargetedChannels, trunkScale, maximumWorldDeltaM: Number(maximumWorldDelta.toFixed(4)),
    changes: 'Compact torso and modestly larger head surface; distal trunk joints and translation samples shortened together. Source skin, texture and clip names preserved.',
    limitations: 'Calf-proportion proxy only; anatomy, age-specific gait, trunk contact and commercial provenance require review.' } };
const raw = Buffer.from(JSON.stringify(doc));
const json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const bin = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
jsonHeader.writeUInt32LE(json.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, jsonHeader, json, binHeader, bin]);
writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, sourceSha256, sha256: createHash('sha256').update(result).digest('hex'),
  changedVertices: changed, trunkVertices, maximumWorldDeltaM: maximumWorldDelta }));
