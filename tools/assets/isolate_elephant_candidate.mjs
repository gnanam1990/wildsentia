// Preserve source joint transforms/animation: Blender import currently deforms this rig.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: downloaded_asian_elephant.glb NEW_OUTPUT.glb');
const bytes = readFileSync(source);
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== 'd6ababec061268be32de266aa22e00647e41cf4a1f4130eada9fc23e4d4cbecc')
  throw new Error('Unreviewed source: expected the pinned 24 September 2026 download');
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
const keep = gltf.nodes.find((n) => n.name === 'Object_7');
if (keep?.mesh !== 0 || keep.skin !== 0) throw new Error('Unexpected elephant hierarchy');
let removed = 0;
for (const node of gltf.nodes) {
  if (node.mesh !== undefined && node !== keep) {
    delete node.mesh; delete node.skin; removed++;
  }
}
if (removed !== 8) throw new Error('Unexpected number of scene variants and tree meshes');
// Keep indexed arrays/binary payload intact: animation channel and inverse-bind indices must not shift.
gltf.asset.extras = { ...gltf.asset.extras, vanaReviewOnly: true, sourceSha256: sha,
  modifications: 'Isolated first elephant; other variants and pine meshes detached. Rig, clips and textures unchanged.' };
const raw = Buffer.from(JSON.stringify(gltf));
const json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const remainder = bytes.subarray(20 + jsonLength);
const header = Buffer.from(bytes.subarray(0, 20));
header.writeUInt32LE(20 + json.length + remainder.length, 8); header.writeUInt32LE(json.length, 12);
const result = Buffer.concat([header, json, remainder]);
writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, bytes: result.length, sha256: createHash('sha256').update(result).digest('hex') }));
