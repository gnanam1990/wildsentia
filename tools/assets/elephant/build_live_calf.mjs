// Package the visually reviewed calf-proportion derivative as an interim live asset.
// Usage: node tools/assets/elephant/build_live_calf.mjs NEW_OUTPUT.glb
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const input = fileURLToPath(new URL('../../../tools/assets/sources/review/elephant-2026-09-25/AsianElephantCalfReview.glb', import.meta.url));
const output = process.argv[2];
assert(output && process.argv.length === 3, 'Provide one new output GLB path');
const bytes = readFileSync(input), sourceSha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sourceSha256, '7ef132c352411cf4e88fd740d5a588b93aaceb8c8bc4f2c392bb743ff02efc8a');
const jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
assert.equal(doc.asset.extras.vanaReviewOnly, true);
assert.equal(doc.asset.extras.calfProportionReview.trunkScale, 0.72);
assert.equal(doc.asset.extras.license, 'CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)');
assert.deepEqual(doc.animations.map(clip => clip.name), ['Idle', 'Walk', 'SprayWater 1', 'SprayWater']);
const binary = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
doc.asset.extras = { ...doc.asset.extras, vanaReviewOnly: false, vanaInterimLive: true,
  calfVisual: { sourceSha256,
    changes: 'Pinned tuskless adult-female skin with bounded compact-torso/larger-head surface and distal trunk-joint/translation retargeting.',
    limitations: 'Young-elephant proportion proxy, not validated calf anatomy. Age-specific gait, feeding/drinking/death contact and commercial provenance clearance remain pending.' } };
const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const bin = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
jsonHeader.writeUInt32LE(json.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, jsonHeader, json, binHeader, bin]);
writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, sourceSha256, sha256: createHash('sha256').update(result).digest('hex') }));
