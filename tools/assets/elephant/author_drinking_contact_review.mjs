// Append a review-only trunk-to-water-to-jaw contact clip to the pinned centered rig.
// The four licensed source clips, source binary, skin, mesh, materials and images stay byte-exact.
// Usage: node tools/assets/elephant/author_drinking_contact_review.mjs INPUT.glb NEW_OUTPUT.glb [source-spray|water-lift|surface-lift]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AnimationMixer, LoopOnce, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, output, style = 'source-spray'] = process.argv.slice(2);
assert(source && output && source !== output, 'Expected pinned input and a distinct new output');
assert(['source-spray', 'water-lift', 'surface-lift'].includes(style));
const bytes = readFileSync(source), sourceSha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sourceSha256, '1053e07503a5861bf7b319123b8594ab0e3a280ea1633a50d7ced2ab3e66caa9');
assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
const jsonLength = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const originalBin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
const sprayDoc = doc.animations.find(clip => clip.name === 'SprayWater'); assert(sprayDoc);
assert.deepEqual(doc.animations.map(clip => clip.name), ['Idle', 'Walk', 'SprayWater 1', 'SprayWater']);
const parseDoc = structuredClone(doc);
parseDoc.buffers[0].uri = `data:application/octet-stream;base64,${originalBin.toString('base64')}`;
delete parseDoc.images; delete parseDoc.textures; delete parseDoc.materials;
for (const mesh of parseDoc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(parseDoc), '');
const clip = gltf.animations.find(c => c.name === 'SprayWater'); assert(clip);
const byName = new Map(); gltf.scene.traverse(node => byName.set(node.name, node));
const nodes = doc.nodes.map(node => byName.get(node.name));
const trunk = Array.from({ length: 17 }, (_, index) => nodes[84 + index]);
const jaw = nodes[101];
assert(trunk.every(Boolean) && jaw, 'Pinned trunk/jaw joint map changed');
const p = node => node.getWorldPosition(new Vector3());
function solveJawContact(startIndex = 7, passes = 15, maxAngle = .035, target = p(jaw)) {
  for (let pass = 0; pass < passes; pass++) {
    for (let index = 15; index >= startIndex; index--) {
      gltf.scene.updateMatrixWorld(true);
      const joint = trunk[index], origin = p(joint), tip = p(trunk.at(-1));
      const toTip = tip.sub(origin), toTarget = target.clone().sub(origin);
      if (toTip.length() < 1e-6 || toTarget.length() < 1e-6) continue;
      const delta = new Quaternion().setFromUnitVectors(toTip.normalize(), toTarget.normalize());
      const fullAngle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
      const limited = new Quaternion().slerp(delta, Math.min(maxAngle, fullAngle) / Math.max(1e-8, fullAngle));
      const parentWorld = joint.parent.getWorldQuaternion(new Quaternion());
      const world = joint.getWorldQuaternion(new Quaternion());
      joint.quaternion.copy(parentWorld.invert().multiply(limited).multiply(world));
    }
    gltf.scene.updateMatrixWorld(true);
    if (p(trunk.at(-1)).distanceTo(target) < .015) break;
  }
}
const mixer = new AnimationMixer(gltf.scene), action = mixer.clipAction(clip);
action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
const waterTime = .28, liftTime = .9;
const fixedWaterLift = style === 'water-lift' || style === 'surface-lift';
const forward = fixedWaterLift ? waterTime + liftTime : clip.duration;
const hold = .3, duration = forward * 2 + hold, fps = 60;
let waterLiftRotations;
// Mesh-contact hypothesis, not an anatomical certification. The target offsets the
// pinned regularized pose's closest distal-trunk vertex from its bone tip, then
// places that vertex at the closest inferred mouth-region surface vertex.
const surfaceTarget = new Vector3(-.2787, .5315, -.3687);
if (fixedWaterLift) {
  action.reset().play(); mixer.setTime(waterTime); gltf.scene.updateMatrixWorld(true);
  const target = style === 'surface-lift' ? surfaceTarget : p(jaw);
  solveJawContact(2, 100, .02, target);
  const distance = p(trunk.at(-1)).distanceTo(target);
  assert(distance < .02, `Water-lift target not achieved: ${distance}`);
  waterLiftRotations = trunk.slice(2, 16).map(joint => joint.quaternion.clone());
}
const steps = Math.ceil(duration * fps), times = Float32Array.from({ length: steps + 1 }, (_, i) => Math.fround(duration * i / steps));
const channelKeys = sprayDoc.channels.map(channel => `${channel.target.node}:${channel.target.path}`);
assert.equal(new Set(channelKeys).size, channelKeys.length, 'Unexpected duplicate source channel');
const tracks = sprayDoc.channels.map(channel => ({ channel, values: [] }));
const contactSamples = [];
for (let frame = 0; frame < times.length; frame++) {
  const seconds = times[frame];
  const phaseTime = seconds < forward ? seconds : seconds <= forward + hold ? forward : Math.max(0, duration - seconds);
  const sourceTime = fixedWaterLift ? Math.min(phaseTime, waterTime) : phaseTime;
  action.reset().play(); mixer.setTime(sourceTime); gltf.scene.updateMatrixWorld(true);
  const phase = fixedWaterLift ? Math.max(0, Math.min(1, (phaseTime - waterTime) / liftTime)) :
    Math.max(0, Math.min(1, (sourceTime / forward - .7) / .3));
  const blend = phase * phase * (3 - 2 * phase);
  if (blend > 0) {
    if (fixedWaterLift) {
      trunk.slice(2, 16).forEach((joint, i) => joint.quaternion.slerp(waterLiftRotations[i], blend));
    } else {
      const originals = trunk.slice(7, 16).map(joint => joint.quaternion.clone());
      solveJawContact();
      trunk.slice(7, 16).forEach((joint, i) => joint.quaternion.copy(originals[i].slerp(joint.quaternion, blend)));
    }
    gltf.scene.updateMatrixWorld(true);
  }
  if (frame === 0 || frame === steps || Math.abs(phaseTime - forward) < duration / steps ||
      Math.abs(sourceTime / forward - .20416666666666666) < duration / steps) {
    contactSamples.push({ seconds: +seconds.toFixed(5), sourceTime: +sourceTime.toFixed(5),
      trunkTip: p(trunk.at(-1)).toArray(), jaw: p(jaw).toArray() });
  }
  for (const track of tracks) {
    const node = nodes[track.channel.target.node];
    const path = track.channel.target.path;
    assert(node && ['translation', 'rotation', 'scale'].includes(path));
    let values = path === 'rotation' ? node.quaternion.toArray() : path === 'translation' ? node.position.toArray() : node.scale.toArray();
    if (path === 'rotation' && track.values.length) {
      const last = track.values.slice(-4), dot = values.reduce((sum, value, i) => sum + value * last[i], 0);
      if (dot < 0) values = values.map(value => -value);
    }
    assert(values.every(Number.isFinite)); track.values.push(...values);
  }
}
assert(contactSamples.some(sample => Math.abs(sample.trunkTip[1]) < .02), 'No trunk-to-water plane sample');
if (style !== 'surface-lift') assert(contactSamples.some(sample => Math.hypot(...sample.trunkTip.map((value, i) => value - sample.jaw[i])) < .02),
  'No trunk-to-jaw anchor sample');
else assert(contactSamples.some(sample => Math.hypot(...sample.trunkTip.map((value, i) => value - surfaceTarget.getComponent(i))) < .02),
  'No trunk-to-derived-surface target sample');

const chunks = [originalBin], pad = (4 - originalBin.length % 4) % 4;
if (pad) chunks.push(Buffer.alloc(pad));
let offset = originalBin.length + pad;
function append(array, type, size) {
  const data = Buffer.from(array.buffer, array.byteOffset, array.byteLength), bufferView = doc.bufferViews.length;
  doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
  chunks.push(data); offset += data.length;
  const accessor = doc.accessors.length;
  doc.accessors.push({ bufferView, componentType: 5126, count: array.length / size, type,
    ...(type === 'SCALAR' ? { min: [array[0]], max: [array.at(-1)] } : {}) });
  return accessor;
}
const dynamicTime = append(times, 'SCALAR', 1), constantTime = append(Float32Array.of(0), 'SCALAR', 1);
const authored = { name: style === 'surface-lift' ? 'DrinkingSurfaceReview' : style === 'water-lift' ? 'DrinkingContactRegularizedReview' : 'DrinkingContactReview', samplers: [], channels: [] };
for (const track of tracks) {
  const size = track.channel.target.path === 'rotation' ? 4 : 3;
  const first = track.values.slice(0, size);
  const constant = track.values.every((value, i) => Math.abs(value - first[i % size]) < 1e-7);
  const outputAccessor = append(Float32Array.from(constant ? first : track.values), size === 4 ? 'VEC4' : 'VEC3', size);
  authored.channels.push({ sampler: authored.samplers.length, target: { ...track.channel.target } });
  authored.samplers.push({ input: constant ? constantTime : dynamicTime, output: outputAccessor, interpolation: 'LINEAR' });
}
doc.animations.push(authored);
doc.asset.extras = { ...doc.asset.extras, vanaReviewOnly: true,
  drinkingContactReview: { sourceSha256, sourceClip: 'SprayWater', clip: authored.name, fps, duration,
    method: style === 'surface-lift' ?
      'Source spray to water at 0.28 s, fixed-head 0.9 s distributed-joint trunk lift to measured inferred mouth-region skin target, 0.3 s hold, reverse return. Surface target is a pinned rig-specific hypothesis, not a verified anatomical marker.' :
      style === 'water-lift' ?
      'Source spray to water contact at 0.28 s, then a fixed-head, 0.9 s distributed-joint trunk lift to jaw anchor, 0.3 s hold, reverse return.' :
      'Forward source spray, 0.3 s jaw-anchor hold, reverse source spray; bounded CCD on distal trunk joints during final 30% of each lift.',
    policy: 'Review only. No visible water prop or visual acceptance implied; source SprayWater clip remains unchanged.' } };
doc.buffers[0].byteLength = offset;
const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const binary = Buffer.concat(chunks), header = Buffer.from(bytes.subarray(0, 20)), binHeader = Buffer.alloc(8);
header.writeUInt32LE(28 + json.length + binary.length, 8); header.writeUInt32LE(json.length, 12);
binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, json, binHeader, binary]);
writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, bytes: result.length, sha256: createHash('sha256').update(result).digest('hex'),
  sourceSha256, clip: authored.name, duration, channels: authored.channels.length, contactSamples, reviewOnly: true }, null, 2));
