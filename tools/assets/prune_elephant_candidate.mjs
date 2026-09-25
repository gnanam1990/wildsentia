// Pinned, lossless rig/payload pruning. This is a review candidate, not automatic live promotion.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: AsianElephantCandidate.glb NEW_OUTPUT.glb');
const bytes = readFileSync(source), sha = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha, 'bdb3cf6d23b15efafd2a28b595e7324f520c52d765e8f3c41aef46ecbce02e4b', 'Expected pinned isolated candidate');
const length = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + length));
const bin = bytes.subarray(28 + length, 28 + length + doc.buffers[0].byteLength);
assert(!doc.extensionsUsed && doc.skins.length === 1 && doc.scenes.length === 1);
const primitive = doc.meshes[0].primitives[0], skin = doc.skins[0];
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const widths = { 5123: 2, 5125: 4, 5126: 4 };
function unpack(index) {
  const a = doc.accessors[index], view = doc.bufferViews[a.bufferView];
  assert(!a.sparse && !a.normalized && components[a.type] && widths[a.componentType]);
  const size = components[a.type] * widths[a.componentType], result = Buffer.alloc(size * a.count);
  for (let i = 0; i < a.count; i++) {
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * (view.byteStride ?? size);
    assert(start + size <= bin.length);
    bin.copy(result, i * size, start, start + size);
  }
  return result;
}
const joints = unpack(primitive.attributes.JOINTS_0), weights = unpack(primitive.attributes.WEIGHTS_0);
assert.equal(doc.accessors[primitive.attributes.JOINTS_0].componentType, 5123);
assert.equal(doc.accessors[primitive.attributes.WEIGHTS_0].componentType, 5126);
const used = new Set();
for (let i = 0; i < joints.length / 2; i++) if (weights.readFloatLE(i * 4) > 0) used.add(joints.readUInt16LE(i * 2));
const indices = [...used].sort((a, b) => a - b), jointMap = new Map(indices.map((old, index) => [old, index]));
assert.equal(indices.length, 64);
for (let i = 0; i < joints.length / 2; i++) joints.writeUInt16LE(weights.readFloatLE(i * 4) > 0 ? jointMap.get(joints.readUInt16LE(i * 2)) : 0, i * 2);

// Ancestors remain even when they have no direct vertex weights. Removing those transforms
// would change all descendant poses. Detached helper branches and their tracks can be dropped.
const parent = new Map();
doc.nodes.forEach((node, i) => { for (const child of node.children ?? []) { assert(!parent.has(child)); parent.set(child, i); } });
const retained = new Set();
function retain(node) { while (node !== undefined && !retained.has(node)) { retained.add(node); node = parent.get(node); } }
retain(7); retain(skin.skeleton); for (const index of indices) retain(skin.joints[index]);
const nodes = [...retained].sort((a, b) => a - b), nodeMap = new Map(nodes.map((old, index) => [old, index]));
const bufferViews = [], accessors = [], chunks = [], accessorMap = new Map(); let byteLength = 0;
function append(data, target) {
  const padding = (4 - byteLength % 4) % 4;
  if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding; }
  const index = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length, ...(target ? { target } : {}) });
  chunks.push(data); byteLength += data.length; return index;
}
function pack(index, data, count) {
  if (!data && accessorMap.has(index)) return accessorMap.get(index);
  const original = doc.accessors[index], a = { ...original };
  a.bufferView = append(data ?? unpack(index), doc.bufferViews[original.bufferView].target);
  delete a.byteOffset;
  if (data) { delete a.min; delete a.max; if (count !== undefined) a.count = count; }
  const next = accessors.length; accessors.push(a);
  if (!data) accessorMap.set(index, next); return next;
}
const attributes = Object.fromEntries(Object.entries(primitive.attributes).map(([key, index]) =>
  [key, key === 'JOINTS_0' ? pack(index, joints) : pack(index)]));
const packedPrimitive = { ...primitive, attributes, indices: pack(primitive.indices), material: 0 };
const inverse = unpack(skin.inverseBindMatrices);
const inverseBindMatrices = pack(skin.inverseBindMatrices, Buffer.concat(indices.map((i) => inverse.subarray(i * 64, (i + 1) * 64))), indices.length);
const animations = doc.animations.map((animation) => {
  const channels = animation.channels.filter((channel) => retained.has(channel.target.node));
  const oldSamplers = [...new Set(channels.map((channel) => channel.sampler))], map = new Map(oldSamplers.map((old, index) => [old, index]));
  return { ...animation, channels: channels.map((channel) => ({ ...channel, sampler: map.get(channel.sampler),
    target: { ...channel.target, node: nodeMap.get(channel.target.node) } })),
    samplers: oldSamplers.map((index) => { const sampler = animation.samplers[index];
      return { ...sampler, input: pack(sampler.input), output: pack(sampler.output) }; }) };
});
const image = doc.images[0], imageView = doc.bufferViews[image.bufferView];
const imageBufferView = append(bin.subarray(imageView.byteOffset, imageView.byteOffset + imageView.byteLength));
assert.deepEqual(doc.textures[0], { sampler: 0, source: 0 });
assert.equal(doc.materials[0].pbrMetallicRoughness.baseColorTexture.index, 0);
const result = {
  asset: { ...doc.asset, extras: { ...doc.asset.extras, vanaReviewOnly: true, isolatedSourceSha256: sha,
    modifications: 'First elephant only; 64 weighted skin joints retained with all required ancestor transforms. Unneeded branches and unrelated geometry/images removed; retained animation channels remapped without changing keyframes.' } },
  nodes: nodes.map((index) => { const node = { ...doc.nodes[index] };
    if (node.children) node.children = node.children.filter((child) => retained.has(child)).map((child) => nodeMap.get(child));
    if (node.mesh !== undefined) { assert.equal(index, 7); node.mesh = 0; node.skin = 0; }
    return node; }),
  scenes: [{ ...doc.scenes[0], nodes: doc.scenes[0].nodes.filter((i) => retained.has(i)).map((i) => nodeMap.get(i)) }], scene: 0,
  meshes: [{ ...doc.meshes[0], primitives: [packedPrimitive] }],
  skins: [{ ...skin, joints: indices.map((i) => nodeMap.get(skin.joints[i])), skeleton: nodeMap.get(skin.skeleton), inverseBindMatrices }],
  animations, materials: [doc.materials[0]], textures: [doc.textures[0]], samplers: [doc.samplers[0]],
  images: [{ ...image, bufferView: imageBufferView }], accessors, bufferViews, buffers: [{ byteLength }],
};
const raw = Buffer.from(JSON.stringify(result));
const json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const binary = Buffer.concat([...chunks, Buffer.alloc((4 - byteLength % 4) % 4)]);
const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + json.length + binary.length, 8); header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
const outputBytes = Buffer.concat([header, json, binHeader, binary]);
writeFileSync(output, outputBytes, { flag: 'wx' });
console.log(JSON.stringify({ output, bytes: outputBytes.length, sha256: createHash('sha256').update(outputBytes).digest('hex'),
  nodes: result.nodes.length, skinJoints: indices.length, triangles: doc.accessors[primitive.indices].count / 3,
  clips: result.animations.map((a) => ({ name: a.name, channels: a.channels.length })), reviewOnly: true }));
