// Append an in-place, review-only climbing loop to the pinned project-authored Langur GLB.
// No original BIN bytes, rig, skin, materials or existing clips are rewritten.
// Usage: node tools/assets/arboreal/author_langur_climb_review.mjs SOURCE.glb NEW_OUTPUT.glb
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AnimationMixer, LoopOnce, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, output] = process.argv.slice(2);
assert(source && output && source !== output, 'pinned source and distinct new output required');
const bytes = readFileSync(source), sourceSha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sourceSha256, 'baed053b237edf9dbf08b408b8319efac9e3bd2f290e27ea3677208532c69c2b');
assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
const jsonLength = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const originalBin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
assert.deepEqual(doc.animations.map(clip => clip.name),
  ['Death', 'Drinking', 'Eating', 'Idle', 'Injured', 'Resting', 'Run', 'Walk']);
assert.equal(doc.skins.length, 1); assert.equal(doc.skins[0].joints.length, 21);
const parseDoc = structuredClone(doc);
parseDoc.buffers[0].uri = `data:application/octet-stream;base64,${originalBin.toString('base64')}`;
delete parseDoc.images; delete parseDoc.textures; delete parseDoc.materials;
for (const mesh of parseDoc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(parseDoc), '');
const byName = new Map(); gltf.scene.traverse(node => byName.set(node.name, node));
const lookup = name => byName.get(name.replaceAll('.', ''));
const nodes = doc.nodes.map(node => lookup(node.name));
assert(nodes.every(Boolean), 'pinned node map changed');
const root = lookup('root'), head = lookup('head');
const feet = ['front.-1', 'front.1', 'back.-1', 'back.1'].map(name => ({
  upper: lookup(name), lower: lookup(`${name}.lower`), foot: lookup(`${name}.foot`), name,
}));
assert(root && head && feet.every(limb => limb.upper && limb.lower && limb.foot));
const p = node => node.getWorldPosition(new Vector3());
const axisX = new Vector3(1, 0, 0);
function ccdTo(limb, target) {
  for (let pass = 0; pass < 28; pass++) {
    for (const joint of [limb.lower, limb.upper]) {
      gltf.scene.updateMatrixWorld(true);
      const origin = p(joint), toFoot = p(limb.foot).sub(origin), toTarget = target.clone().sub(origin);
      if (toFoot.lengthSq() < 1e-10 || toTarget.lengthSq() < 1e-10) continue;
      const delta = new Quaternion().setFromUnitVectors(toFoot.normalize(), toTarget.normalize());
      const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
      const limited = new Quaternion().slerp(delta, Math.min(.09, angle) / Math.max(1e-8, angle));
      const parentWorld = joint.parent.getWorldQuaternion(new Quaternion());
      const world = joint.getWorldQuaternion(new Quaternion());
      joint.quaternion.copy(parentWorld.invert().multiply(limited).multiply(world));
    }
    gltf.scene.updateMatrixWorld(true);
    if (p(limb.foot).distanceTo(target) < .012) break;
  }
}

const idle = gltf.animations.find(clip => clip.name === 'Idle'); assert(idle);
const idleDoc = doc.animations.find(clip => clip.name === 'Idle');
const mixer = new AnimationMixer(gltf.scene), action = mixer.clipAction(idle);
action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
mixer.setTime(0);
const idlePose = nodes.map(node => ({ position: node.position.clone(),
  quaternion: node.quaternion.clone(), scale: node.scale.clone() }));
const duration = 2, fps = 24, steps = duration * fps;
const times = Float32Array.from({ length: steps + 1 }, (_, frame) => frame / fps);
const tracks = idleDoc.channels.map(channel => ({ channel, values: [] }));
const contactSamples = [];
for (let frame = 0; frame <= steps; frame++) {
  const seconds = times[frame], phase = 2 * Math.PI * seconds / duration;
  // AnimationMixer#setTime(0) does not restore an already sampled t=0 pose.
  // Reset all nodes explicitly so authored keys cannot accumulate root motion.
  nodes.forEach((node, index) => { const pose = idlePose[index];
    node.position.copy(pose.position); node.quaternion.copy(pose.quaternion); node.scale.copy(pose.scale); });
  gltf.scene.updateMatrixWorld(true);
  // Root tilt converts the quadruped bind silhouette to an in-place vertical cling.
  // The simulation owns world ascent; this clip never translates up the six-metre tree.
  root.quaternion.premultiply(new Quaternion().setFromAxisAngle(axisX, -1.2));
  root.position.y += .3;
  gltf.scene.updateMatrixWorld(true);
  for (const limb of feet) {
    const left = limb.name.includes('-1'), fore = limb.name.startsWith('front');
    const swing = Math.sin(phase) * (left ? 1 : -1) * (fore ? 1 : -1);
    const target = new Vector3(left ? -.17 : .17, (fore ? .83 : .27) + swing * (fore ? .07 : .05), -.18);
    ccdTo(limb, target);
  }
  // Keep the source tail identity, with modest opposed sway. No prehensile grasp is claimed.
  for (const [index, name] of ['tail0', 'tail1', 'tail2', 'tail3'].entries()) {
    const joint = lookup(name);
    joint.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0),
      Math.sin(phase + index * .35) * .06));
  }
  gltf.scene.updateMatrixWorld(true);
  if (frame % 12 === 0) contactSamples.push({ seconds,
    footJoints: feet.map(limb => ({ name: limb.name, position: p(limb.foot).toArray() })),
    head: p(head).toArray() });
  for (const track of tracks) {
    const node = nodes[track.channel.target.node], path = track.channel.target.path;
    assert(['translation', 'rotation', 'scale'].includes(path));
    let values = path === 'rotation' ? node.quaternion.toArray() : path === 'translation'
      ? node.position.toArray() : node.scale.toArray();
    if (path === 'rotation' && track.values.length) {
      const last = track.values.slice(-4);
      if (values.reduce((sum, value, i) => sum + value * last[i], 0) < 0) values = values.map(value => -value);
    }
    assert(values.every(Number.isFinite)); track.values.push(...values);
  }
}
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
const authored = { name: 'ClimbReview', samplers: [], channels: [] };
for (const track of tracks) {
  const size = track.channel.target.path === 'rotation' ? 4 : 3, first = track.values.slice(0, size);
  const constant = track.values.every((value, i) => Math.abs(value - first[i % size]) < 1e-7);
  const output = append(Float32Array.from(constant ? first : track.values), size === 4 ? 'VEC4' : 'VEC3', size);
  authored.channels.push({ sampler: authored.samplers.length, target: { ...track.channel.target } });
  authored.samplers.push({ input: constant ? constantTime : dynamicTime, output, interpolation: 'LINEAR' });
}
doc.animations.push(authored);
doc.asset.extras = { ...doc.asset.extras, vanaReviewOnly: true,
  climbReview: { sourceSha256, sourceClip: 'Idle', clip: authored.name, fps, duration,
    method: 'In-place vertical root tilt, four two-joint paw targets on an illustrative trunk plane, opposed limb cycle and modest tail sway.',
    policy: 'Review only. No exact-species anatomy, independent finger grip, textured contact or live acceptance implied.' } };
doc.buffers[0].byteLength = offset;
const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
const binary = Buffer.concat(chunks), header = Buffer.from(bytes.subarray(0, 20)), binHeader = Buffer.alloc(8);
header.writeUInt32LE(28 + json.length + binary.length, 8); header.writeUInt32LE(json.length, 12);
binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, json, binHeader, binary]);
writeFileSync(output, result, { flag: 'wx' });
console.log(JSON.stringify({ output, sha256: createHash('sha256').update(result).digest('hex'),
  sourceSha256, bytes: result.length, originalClipCount: 8, authoredChannels: authored.channels.length,
  contactSamples, reviewOnly: true }, null, 2));
