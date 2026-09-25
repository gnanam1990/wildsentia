// Reproducible review-only affine wrapper: no mesh, bind, clip or embedded texture edits.
// Usage: node tools/assets/elephant/normalize_centered_review.mjs PINNED_LOOP.glb NEW_REVIEW.glb
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, output] = process.argv.slice(2);
assert(source && output && source !== output, 'Usage: PINNED_LOOP.glb NEW_REVIEW.glb');
const bytes = readFileSync(source);
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, '6e42ca4efb52f818317955ba1c85f1efaf5bd995dbfbf2c4889e4c1d6500be6c',
  'Expected the pinned loop-review Asian elephant; refusing unknown input');
assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
assert.equal(bytes.readUInt32LE(4), 2);
assert.equal(bytes.readUInt32LE(8), bytes.length);
const jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
assert.equal(doc.asset.extras?.vanaReviewOnly, true);
assert.equal(doc.buffers.length, 1);
assert(!doc.buffers[0].uri);
assert.equal(doc.scenes[doc.scene].nodes.length, 1);
const binary = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
assert.equal(binary.length, doc.buffers[0].byteLength);

// The animal loader uses Box3.setFromObject before playing a clip. Derive normalization from
// precisely that same geometry/bind-pose measurement, with images omitted only in this probe.
const probe = structuredClone(doc);
probe.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
delete probe.images; delete probe.textures; delete probe.materials;
for (const mesh of probe.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(probe), '');
const bounds = new Box3().setFromObject(gltf.scene);
assert(!bounds.isEmpty());
const size = bounds.getSize(new Vector3());
assert(Number.isFinite(size.y) && size.y > 0);
const centre = bounds.getCenter(new Vector3());
const unitScale = 1 / size.y;
const root = doc.nodes.length;
doc.nodes.push({ name: 'VANA_centered_review_root', children: [...doc.scenes[doc.scene].nodes],
  translation: [-centre.x * unitScale, -bounds.min.y * unitScale, -centre.z * unitScale],
  scale: [unitScale, unitScale, unitScale] });
doc.scenes[doc.scene].nodes = [root];
doc.asset.extras = { ...doc.asset.extras, vanaReviewOnly: true,
  centeredRootReview: { sourceSha256: sha256, method: 'One parent transform from Three.js bind-pose Box3; unit height, centred X/Z, feet at Y=0',
    sourceBounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, unitScale,
    status: 'placement review only; feeding, drinking, death, gait contact and visual acceptance remain incomplete' } };

const raw = Buffer.from(JSON.stringify(doc));
const json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const bin = bytes.subarray(20 + jsonLength); // Includes original BIN chunk header, bytes and padding intact.
const header = Buffer.from(bytes.subarray(0, 20));
header.writeUInt32LE(20 + json.length + bin.length, 8);
header.writeUInt32LE(json.length, 12);
const result = Buffer.concat([header, json, bin]);
writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, bytes: result.length,
  sha256: createHash('sha256').update(result).digest('hex'), sourceSha256: sha256,
  sourceBounds: doc.asset.extras.centeredRootReview.sourceBounds, unitScale, reviewOnly: true }));
