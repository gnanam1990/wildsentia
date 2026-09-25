// Make a reversible tuskless art-review derivative from the pinned local adult-male GLB.
// The paired disconnected ivory surfaces are degenerated in the index buffer; source
// vertices, skin, images and animation remain intact. This is not a validated female rig.
// Usage: node tools/assets/elephant/build_tuskless_review.mjs NEW_OUTPUT.glb
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const input = fileURLToPath(new URL('../../../packages/client/public/assets/animals/AsianElephantAdultMale.glb', import.meta.url));
const output = process.argv[2]; assert(output && process.argv.length === 3);
const bytes = readFileSync(input), hash = createHash('sha256').update(bytes).digest('hex');
assert.equal(hash, 'fa5095bb38155cc041363ac60eb6d9a2f56cc660ffa2e322fd8a229afc841c8c');
const jsonLength = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
const data = Buffer.from(bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength));
const accessor = doc.accessors[doc.meshes[0].primitives[0].indices];
const view = doc.bufferViews[accessor.bufferView];
assert.equal(accessor.componentType, 5125); assert.equal(accessor.count, 20982);
const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
const indices = Array.from({ length: accessor.count }, (_, i) => data.readUInt32LE(offset + i * 4));
const parent = Uint32Array.from({ length: 4768 }, (_, i) => i);
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
for (let i = 0; i < indices.length; i += 3) { union(indices[i], indices[i + 1]); union(indices[i + 1], indices[i + 2]); }
const pairedSurfaces = new Map([[2387, 122], [2308, 94], [4518, 122], [4433, 94]]);
const removed = new Map([...pairedSurfaces].map(([root]) => [root, 0]));
for (let i = 0; i < indices.length; i += 3) {
  const root = find(indices[i]);
  if (!pairedSurfaces.has(root)) continue;
  removed.set(root, removed.get(root) + 1);
  data.writeUInt32LE(indices[i], offset + (i + 1) * 4);
  data.writeUInt32LE(indices[i], offset + (i + 2) * 4);
}
assert.deepEqual([...removed], [...pairedSurfaces]);
doc.asset.extras = { ...doc.asset.extras, vanaReviewOnly: true, vanaInterimLive: false,
  tusklessReview: { sourceSha256: hash, removedTriangles: 432,
    method: 'Degenerated four pinned disconnected ivory surface islands; no other geometry, skin, textures or animation changed.',
    limitation: 'Adult-male body proportions remain. Not female anatomy clearance or a calf/young rig.' } };
const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const bin = Buffer.concat([data, Buffer.alloc((4 - data.length % 4) % 4)]);
const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
jsonHeader.writeUInt32LE(json.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, jsonHeader, json, binHeader, bin]);
writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, sourceSha256: hash, sha256: createHash('sha256').update(result).digest('hex'), removedTriangles: [...removed] }));
