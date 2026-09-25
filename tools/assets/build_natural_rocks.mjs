/** Download two reviewed CC0 sources and build self-contained, simplified GLBs.
 * npm ci --prefix tools/assets --ignore-scripts
 * node tools/assets/build_natural_rocks.mjs ASSET_ID SCRATCH_DIRECTORY OUTPUT.glb
 * Powered by Poly Haven: https://polyhaven.com — no runtime network dependency.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { MeshoptSimplifier } from 'meshoptimizer';

const reviewed = {
  boulder_01: {
    title: 'NaturalBoulder', author: 'Rico Cilliers', triangles: 6000,
    files: {
      'boulder_01_1k.gltf': '26e2eef4a1f68c9557c65cd375b21d6c',
      'boulder_01.bin': '27a19fa031d8b4c3a09261f19c444dc5',
      'textures/boulder_01_arm_1k.jpg': 'd632159982cc3121ed3d69b89a122146',
      'textures/boulder_01_diff_1k.jpg': '25f8a843f13369d56d37f49db05ea8c3',
      'textures/boulder_01_nor_gl_1k.jpg': '0c4da644d901144b53e4fe2446f3c389',
    },
  },
  rock_07: {
    title: 'NaturalStone', author: 'Jenelle van Heerden', triangles: 2000,
    files: {
      'rock_07_1k.gltf': '2bdb563c126a9d284e60e94951759e2f',
      'rock_07.bin': '817b2cfd1626cb06f18a825f87f58ec3',
      'textures/rock_07_arm_1k.jpg': '530bfd2a510fe6f778bb1198a2395574',
      'textures/rock_07_diff_1k.jpg': 'b68ac1824bb3bd3867641b830ad02099',
      'textures/rock_07_nor_gl_1k.jpg': 'd3a2a0df0db0177c4df8ef644b003652',
    },
  },
};
const [id, directory, output] = process.argv.slice(2);
if (!Object.hasOwn(reviewed, id ?? '') || !directory || !output) throw new Error('Expected reviewed asset ID, scratch directory and new output path');
const spec = reviewed[id], root = resolve(directory, id);
const digest = (data, type = 'md5') => createHash(type).update(data).digest('hex');
const manifestResponse = await fetch(`https://api.polyhaven.com/files/${id}`);
if (!manifestResponse.ok) throw new Error(`Manifest HTTP ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
const source = manifest.gltf['1k'].gltf;
const entries = [[`${id}_1k.gltf`, source], ...Object.entries(source.include)];
if (entries.length !== Object.keys(spec.files).length) throw new Error('Source file set changed; review before rebuilding');
const downloaded = new Map();
for (const [name, file] of entries) {
  if (spec.files[name] !== file.md5) throw new Error(`Publisher source changed: ${name}`);
  const target = resolve(root, name), url = new URL(file.url);
  if (!target.startsWith(root + sep) || url.protocol !== 'https:' || url.hostname !== 'dl.polyhaven.org') throw new Error('Unexpected source path/origin');
  let data;
  try { data = await readFile(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!data) {
    const response = await fetch(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${name}`);
    data = Buffer.from(await response.arrayBuffer());
    if (data.length !== file.size || digest(data) !== file.md5) throw new Error(`Integrity mismatch: ${name}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }
  if (data.length !== file.size || digest(data) !== file.md5) throw new Error(`Cached source differs: ${name}`);
  downloaded.set(name, data);
  console.log(`${name}: ${data.length} bytes, reviewed publisher MD5 verified`);
}
const sourceGltf = JSON.parse(downloaded.get(`${id}_1k.gltf`).toString());
// Narrow, pinned input contract: no scene execution, unsupported transforms or silent loss.
if (sourceGltf.nodes.length !== 1 || sourceGltf.meshes.length !== 1 || sourceGltf.meshes[0].primitives.length !== 1
  || sourceGltf.buffers.length !== 1 || sourceGltf.animations || sourceGltf.extensionsRequired
  || ['translation', 'rotation', 'scale', 'matrix', 'children'].some((key) => sourceGltf.nodes[0][key])) {
  throw new Error('Source layout changed; this converter handles one identity static mesh');
}
const binary = downloaded.get(sourceGltf.buffers[0].uri);
if (!binary || binary.length !== sourceGltf.buffers[0].byteLength) throw new Error('Missing source geometry');
const primitive = sourceGltf.meshes[0].primitives[0];
function readAccessor(index, components, integer = false) {
  const a = sourceGltf.accessors[index], view = sourceGltf.bufferViews[a.bufferView];
  if (a.sparse || a.normalized || view.buffer !== 0 || a.type !== ({ 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3' })[components]
    || !(integer ? [5123, 5125] : [5126]).includes(a.componentType)) throw new Error('Unsupported accessor');
  const bytes = a.componentType === 5123 ? 2 : 4;
  const stride = view.byteStride ?? components * bytes;
  const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  if (stride < components * bytes || start < 0 || start + (a.count - 1) * stride + components * bytes > binary.length) throw new Error('Accessor bounds');
  const values = integer ? new Uint32Array(a.count * components) : new Float32Array(a.count * components);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < components; c++) {
    const offset = start + i * stride + c * bytes;
    const v = !integer ? binary.readFloatLE(offset) : bytes === 2 ? binary.readUInt16LE(offset) : binary.readUInt32LE(offset);
    if (!Number.isFinite(v)) throw new Error('Non-finite geometry');
    values[i * components + c] = v;
  }
  return values;
}
const positions = readAccessor(primitive.attributes.POSITION, 3);
const normals = readAccessor(primitive.attributes.NORMAL, 3);
const uvs = readAccessor(primitive.attributes.TEXCOORD_0, 2);
const indices = readAccessor(primitive.indices, 1, true);
if (normals.length !== positions.length || uvs.length / 2 !== positions.length / 3 || indices.length % 3
  || indices.some((i) => i >= positions.length / 3)) throw new Error('Inconsistent source mesh');
await MeshoptSimplifier.ready;
const attributes = new Float32Array(positions.length / 3 * 5);
for (let i = 0; i < positions.length / 3; i++) attributes.set([...uvs.subarray(i * 2, i * 2 + 2), ...normals.subarray(i * 3, i * 3 + 3)], i * 5);
// The boulder has extensive split vertices. Permit seam collapses while explicitly
// accounting for UV/normal error; the final textured result still requires visual review.
const flags = id === 'boulder_01' ? ['Permissive'] : [];
const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, 5, [1, 1, 0.5, 0.5, 0.5], null, spec.triangles * 3, 0.03, flags);
if (simplified.length / 3 > spec.triangles * 2 || simplified.length < 300) throw new Error(`Triangle budget not reached: ${simplified.length / 3}`);
const [remap, vertexCount] = MeshoptSimplifier.compactMesh(simplified);
function compact(values, components) {
  const result = new Float32Array(vertexCount * components);
  for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) result.set(values.subarray(i * components, (i + 1) * components), remap[i] * components);
  return result;
}
const p = compact(positions, 3), n = compact(normals, 3), uv = compact(uvs, 2);
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < p.length; i++) { const c = i % 3; min[c] = Math.min(min[c], p[i]); max[c] = Math.max(max[c], p[i]); }
const height = max[1] - min[1], centre = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
if (!(height > 0)) throw new Error('Invalid rock height');
for (let i = 0; i < p.length; i++) p[i] = (p[i] - centre[i % 3]) / height;
const normalizedMin = min.map((v, c) => (v - centre[c]) / height), normalizedMax = max.map((v, c) => (v - centre[c]) / height);
const gltf = { asset: { version: '2.0', generator: 'VANA reviewed rock converter / meshoptimizer 1.2.0',
  copyright: `${spec.author} / Poly Haven — CC0`, extras: { source: `https://polyhaven.com/a/${id}`,
    sourceFilesMD5: spec.files, sourceTriangles: indices.length / 3, triangles: simplified.length / 3,
    simplificationError: error, normalizedHeightM: 1, geologyAccurate: false } },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: spec.title }],
  meshes: [{ name: spec.title, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  materials: sourceGltf.materials, textures: sourceGltf.textures, samplers: sourceGltf.samplers,
  images: [], accessors: [], bufferViews: [], buffers: [] };
// The publisher's ARM image has AO in R. The source uses G/B but omits its AO binding.
gltf.materials[0].occlusionTexture = { ...gltf.materials[0].pbrMetallicRoughness.metallicRoughnessTexture };
const chunks = []; let byteLength = 0;
function addBytes(data, target) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const view = { buffer: 0, byteOffset: byteLength, byteLength: bytes.length, ...(target ? { target } : {}) };
  chunks.push(bytes); byteLength += bytes.length;
  const padding = (4 - byteLength % 4) % 4; if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding; }
  gltf.bufferViews.push(view); return gltf.bufferViews.length - 1;
}
for (const [values, components, type] of [[p, 3, 'VEC3'], [n, 3, 'VEC3'], [uv, 2, 'VEC2']]) {
  gltf.accessors.push({ bufferView: addBytes(values, 34962), componentType: 5126, count: values.length / components, type,
    ...(values === p ? { min: normalizedMin, max: normalizedMax } : {}) });
}
const finalIndices = vertexCount <= 65535 ? Uint16Array.from(simplified) : simplified;
gltf.accessors.push({ bufferView: addBytes(finalIndices, 34963), componentType: vertexCount <= 65535 ? 5123 : 5125, count: finalIndices.length, type: 'SCALAR' });
for (const image of sourceGltf.images) {
  const bytes = downloaded.get(image.uri);
  if (!bytes || image.mimeType !== 'image/jpeg') throw new Error('Unexpected image');
  gltf.images.push({ name: image.name, mimeType: image.mimeType, bufferView: addBytes(bytes) });
}
gltf.buffers.push({ byteLength });
const json = Buffer.from(JSON.stringify(gltf)), jsonPadding = Buffer.alloc((4 - json.length % 4) % 4, 0x20);
const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + json.length + jsonPadding.length + byteLength, 8);
header.writeUInt32LE(json.length + jsonPadding.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(byteLength); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, json, jsonPadding, binHeader, ...chunks]);
let existing;
try { existing = await readFile(resolve(output)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (existing && !existing.equals(result)) throw new Error('Output exists with different content; choose a new output path for review');
if (!existing) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), result, { flag: 'wx' }); }
console.log(JSON.stringify({ output: resolve(output), bytes: result.length, triangles: simplified.length / 3, error, sha256: digest(result, 'sha256') }));
