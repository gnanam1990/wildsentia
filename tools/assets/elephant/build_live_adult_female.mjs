// Promote the pinned, visually reviewed tuskless local derivative as an interim
// adult-female observer asset. It still carries adult-male source proportions.
// Usage: node tools/assets/elephant/build_live_adult_female.mjs NEW_OUTPUT.glb
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const input = fileURLToPath(new URL('../../../docs/art-review/elephant-2026-09-24/recovered/AsianElephantTusklessReview.glb', import.meta.url));
const output = process.argv[2]; assert(output && process.argv.length === 3);
const bytes = readFileSync(input), hash = createHash('sha256').update(bytes).digest('hex');
assert.equal(hash, '202dbdf848861aee6d3201f32d8c3cd531eded05847a65ffa52ff2644ad02b90');
const jsonLength = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
assert.equal(doc.asset.extras.vanaReviewOnly, true);
assert.equal(doc.asset.extras.tusklessReview.removedTriangles, 432);
assert.equal(doc.asset.extras.license, 'CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)');
const binary = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
doc.asset.extras = { ...doc.asset.extras, vanaReviewOnly: false, vanaInterimLive: true,
  adultFemaleVisual: { sourceSha256: hash,
    changes: 'Tusk surfaces omitted by exact pinned index islands; all remaining mesh, skin, images and clips preserved.',
    limitations: 'Tuskless adult approximation, not validated female body proportions, true drinking/eating/death, young/calf art, uneven-terrain gait or final rights clearance.' } };
const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const bin = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
jsonHeader.writeUInt32LE(json.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, jsonHeader, json, binHeader, bin]);
writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, sourceSha256: hash, sha256: createHash('sha256').update(result).digest('hex') }));
