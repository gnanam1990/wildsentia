// Re-evaluate the actual source and authored GLBs through Three.js CPU skinning.
// Usage: node tools/art/audit_elephant_walk_ground_review.mjs SOURCE.glb REVIEW.glb NEW_REPORT.json NEW_CHART.svg
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AnimationMixer, LoopOnce, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, review, reportPath, chartPath] = process.argv.slice(2);
assert(source && review && reportPath && chartPath);
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
async function load(path) {
  const bytes = readFileSync(path), jsonLength = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
  const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
  const parsed = structuredClone(doc);
  parsed.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
  delete parsed.images; delete parsed.textures; delete parsed.materials;
  for (const mesh of parsed.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(parsed), '');
  const mesh = gltf.scene.getObjectByName('Object_7'); assert(mesh?.isSkinnedMesh);
  return { bytes, doc, bin, gltf, mesh, hash: createHash('sha256').update(bytes).digest('hex') };
}
const a = await load(source), b = await load(review);
assert(b.bin.subarray(0, a.bin.length).equals(a.bin), 'Original BIN bytes changed');
assert.equal(b.doc.asset.extras?.vanaReviewOnly, true);
assert.deepEqual(a.doc.meshes, b.doc.meshes); assert.deepEqual(a.doc.skins, b.doc.skins);
for (const name of ['Idle', 'SprayWater 1', 'SprayWater'])
  assert.deepEqual(a.doc.animations.find(x => x.name === name), b.doc.animations.find(x => x.name === name));
const sourceWalk = a.doc.animations.find(x => x.name === 'Walk');
const reviewWalk = b.doc.animations.find(x => x.name === 'Walk');
assert.deepEqual(reviewWalk.channels.slice(0, -1), sourceWalk.channels);
assert.deepEqual(reviewWalk.samplers.slice(0, -1), sourceWalk.samplers);
const duration = a.gltf.animations.find(x => x.name === 'Walk').duration;
const count = Math.ceil(duration * 60);
const sample = (item, time) => {
  const clip = item.gltf.animations.find(x => x.name === 'Walk');
  const mixer = new AnimationMixer(item.gltf.scene), action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play(); mixer.setTime(time);
  item.gltf.scene.updateMatrixWorld(true); item.mesh.skeleton.update();
  let minY = Infinity, maxXZDifference = 0;
  const points = [];
  for (let i = 0; i < item.mesh.geometry.attributes.position.count; i++) {
    const v = item.mesh.getVertexPosition(i, new Vector3()).applyMatrix4(item.mesh.matrixWorld);
    minY = Math.min(minY, v.y); points.push(v);
  }
  mixer.stopAllAction();
  return { minY, points, maxXZDifference };
};
const samples = [];
let maxXZDelta = 0, maxVerticalDisagreement = 0;
for (let i = 0; i <= count; i++) {
  const time = i * duration / count;
  const before = sample(a, time), after = sample(b, time);
  assert.equal(before.points.length, after.points.length);
  for (let v = 0; v < before.points.length; v++) {
    const p = before.points[v], q = after.points[v];
    maxXZDelta = Math.max(maxXZDelta, Math.hypot(p.x - q.x, p.z - q.z));
    maxVerticalDisagreement = Math.max(maxVerticalDisagreement,
      Math.abs((q.y - p.y) + before.minY));
  }
  samples.push({ seconds: time, beforeMinY: before.minY, afterMinY: after.minY });
}
const maxAbsAfterMin = Math.max(...samples.map(s => Math.abs(s.afterMinY)));
assert(maxAbsAfterMin < 1e-4, `Floor envelope still off: ${maxAbsAfterMin}`);
assert(maxXZDelta < 1e-4 && maxVerticalDisagreement < 1e-4,
  `Unexpected non-rigid change: XZ=${maxXZDelta}, Y=${maxVerticalDisagreement}`);
const report = { sourceSha256: a.hash, reviewSha256: b.hash, sampledHz: 60,
  samples: samples.length, verticesPerSample: a.mesh.geometry.attributes.position.count,
  beforeMinYRange: [Math.min(...samples.map(s => s.beforeMinY)), Math.max(...samples.map(s => s.beforeMinY))],
  afterMinYRange: [Math.min(...samples.map(s => s.afterMinY)), Math.max(...samples.map(s => s.afterMinY))],
  maxAbsAfterMin, maxXZDelta, maxVerticalDisagreement, originalBinPreserved: true,
  originalWalkTracksPreserved: true, otherClipDefinitionsPreserved: true,
  acceptance: 'review only; no stationary foot-plant, mesh-self-intersection, textured playback or licence clearance claimed' };
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
const W = 1000, H = 330, left = 65, top = 35, plotW = 900, plotH = 245;
const x = s => left + (s.seconds / duration) * plotW;
const y = v => top + ((.025 - v) / .05) * plotH;
const line = key => samples.map((s, i) => `${i ? 'L' : 'M'}${x(s).toFixed(2)},${y(s[key]).toFixed(2)}`).join(' ');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<rect width="100%" height="100%" fill="#f6f7f5"/><text x="${left}" y="23" font-family="sans-serif" font-size="17">Asian elephant Walk: lowest skinned vertex vs flat floor (unit body height)</text>
<line x1="${left}" y1="${y(0)}" x2="${left + plotW}" y2="${y(0)}" stroke="#333" stroke-width="1.4"/>
<path d="${line('beforeMinY')}" fill="none" stroke="#c74e37" stroke-width="2"/>
<path d="${line('afterMinY')}" fill="none" stroke="#1e8975" stroke-width="2"/>
<text x="${left}" y="${H - 22}" font-family="sans-serif" font-size="12" fill="#c74e37">Before: red</text>
<text x="${left + 110}" y="${H - 22}" font-family="sans-serif" font-size="12" fill="#1e8975">Review: green</text>
<text x="${left + 300}" y="${H - 22}" font-family="sans-serif" font-size="12">0–${duration.toFixed(2)} s · 60 Hz · ground Y=0 · geometry-only measurement</text></svg>`;
writeFileSync(chartPath, svg, { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
