// Authored review derivative: close only the final 0.3 s of the pinned Walk clip.
// Hermite endpoint position/velocity correction; not gait/contact or visual approval.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
const [source, output] = process.argv.slice(2);
assert(source && output, 'Usage: AsianElephantCompact.glb NEW_OUTPUT.glb');
const bytes = readFileSync(source), sha = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha, '96d92067373527e95f15688e4e92cb08551595021f1a1f21a7c50f9fa8187eb0', 'Expected pinned compact candidate');
const jsonLength = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
const walk = doc.animations.find((a) => a.name === 'Walk'); assert(walk);
function values(index) {
  const a = doc.accessors[index], view = doc.bufferViews[a.bufferView];
  assert(a.componentType === 5126 && !view.byteStride && !a.sparse);
  const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type]; assert(size);
  const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return Float32Array.from({ length: a.count * size }, (_, i) => bin.readFloatLE(offset + i * 4));
}
const duration = Math.max(...walk.samplers.map((s) => values(s.input).at(-1)));
const start = Math.fround(duration - .3), dt = 1 / 120;
assert(duration > 1);
const chunks = [bin], padding = (4 - bin.length % 4) % 4;
if (padding) chunks.push(Buffer.alloc(padding));
let offset = bin.length + padding, modified = 0;
function append(array, type, size) {
  const data = Buffer.from(array.buffer, array.byteOffset, array.byteLength), view = doc.bufferViews.length;
  doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
  chunks.push(data); offset += data.length;
  const index = doc.accessors.length;
  doc.accessors.push({ bufferView: view, componentType: 5126, count: array.length / size, type,
    ...(type === 'SCALAR' ? { min: [array[0]], max: [array.at(-1)] } : {}) });
  return index;
}
walk.samplers = walk.samplers.map((sampler, index) => {
  assert((sampler.interpolation ?? 'LINEAR') === 'LINEAR');
  const channels = walk.channels.filter((c) => c.sampler === index);
  assert(channels.length === 1); const path = channels[0].target.path;
  assert(['translation', 'rotation', 'scale'].includes(path));
  const times = values(sampler.input), data = values(sampler.output), size = path === 'rotation' ? 4 : 3;
  if (times.length === 1) return sampler; // Exact constant tracks need no correction or resampling.
  const track = path === 'rotation' ? new QuaternionKeyframeTrack('review', times, data) : new VectorKeyframeTrack('review', times, data);
  const interpolant = track.createInterpolant(new Float64Array(size));
  const sample = (time) => Array.from(interpolant.evaluate(time));
  const first = sample(0), next = sample(dt), last = sample(duration), before = sample(duration - dt);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const align = (q, reference) => path === 'rotation' && dot(q, reference) < 0 ? q.map((v) => -v) : q;
  const target = align(first, last), following = align(next, target), preceding = align(before, last);
  const delta = target.map((value, i) => value - last[i]);
  const velocityDelta = target.map((value, i) => (following[i] - value - last[i] + preceding[i]) / dt);
  const keptTimes = [], keptValues = [];
  for (let i = 0; i < times.length && times[i] < start; i++) {
    keptTimes.push(times[i]); for (let c = 0; c < size; c++) keptValues.push(data[i * size + c]);
  }
  const steps = Math.ceil((duration - start) * 120);
  for (let i = 0; i <= steps; i++) {
    const time = i === steps ? duration : Math.fround(start + (duration - start) * i / steps);
    const s = (time - start) / (duration - start), positionBlend = s * s * (3 - 2 * s), velocityBlend = s * s * (s - 1);
    const original = align(sample(time), last);
    let corrected = original.map((value, c) => value + positionBlend * delta[c] + velocityBlend * (duration - start) * velocityDelta[c]);
    if (path === 'rotation') {
      const length = Math.hypot(...corrected); assert(length > .5);
      corrected = corrected.map((v) => v / length);
    }
    // Keep endpoint components exactly, including source Float32 rounding/sign equivalence.
    if (i === steps) corrected = target;
    keptTimes.push(time); keptValues.push(...corrected);
  }
  assert(keptTimes.every((time, i) => i === 0 || time > keptTimes[i - 1])); modified++;
  return { ...sampler, input: append(Float32Array.from(keptTimes), 'SCALAR', 1),
    output: append(Float32Array.from(keptValues), size === 4 ? 'VEC4' : 'VEC3', size) };
});
doc.asset.extras = { ...doc.asset.extras, vanaReviewOnly: true, compactSourceSha256: sha,
  walkLoopReview: { duration, correctionStart: start, correctionSeconds: duration - start, samplesPerSecond: 120,
    method: 'Hermite endpoint position and finite-difference velocity correction; normalized quaternion samples. Other clips untouched; visual/contact acceptance pending.' } };
doc.buffers[0].byteLength = offset;
const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const binary = Buffer.concat(chunks), header = Buffer.from(bytes.subarray(0, 20)), binHeader = Buffer.alloc(8);
header.writeUInt32LE(28 + json.length + binary.length, 8); header.writeUInt32LE(json.length, 12);
binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, json, binHeader, binary]); writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, bytes: result.length, sha256: createHash('sha256').update(result).digest('hex'),
  duration, correctionStart: start, modifiedTracks: modified, reviewOnly: true }));
