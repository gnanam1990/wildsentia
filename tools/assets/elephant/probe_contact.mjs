// Read-only joint-space probe for the pinned centred review elephant.
// Usage: node tools/assets/elephant/probe_contact.mjs INPUT.glb
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnimationMixer, LoopOnce, Vector3, Box3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [path] = process.argv.slice(2);
assert(path, 'Expected local GLB path');
const bytes = readFileSync(path), length = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + length));
const bin = bytes.subarray(28 + length, 28 + length + doc.buffers[0].byteLength);
doc.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
delete doc.images; delete doc.textures; delete doc.materials;
for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(doc), '');
const byName = new Map(); gltf.scene.traverse(node => byName.set(node.name, node));
const trunkNames = Array.from({ length: 17 }, (_, i) => doc.nodes[84 + i].name);
const mouthNames = Array.from({ length: 4 }, (_, i) => doc.nodes[101 + i].name);
const bounds = new Box3().setFromObject(gltf.scene);
const out = { bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, clips: [] };
for (const clip of gltf.animations) {
  const mixer = new AnimationMixer(gltf.scene), action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
  const samples = [], summary = { minWaterContact: { distance: Infinity }, minMouthContact: { distance: Infinity } };
  for (let i = 0; i <= 240; i++) {
    const fraction = i / 240;
    action.reset().play(); mixer.setTime(clip.duration * fraction); gltf.scene.updateMatrixWorld(true);
    const trunk = trunkNames.map(name => byName.get(name).getWorldPosition(new Vector3()));
    const mouth = mouthNames.map(name => byName.get(name).getWorldPosition(new Vector3()));
    const tip = trunk.at(-1), minMouth = Math.min(...mouth.map(joint => joint.distanceTo(tip)));
    const water = Math.abs(tip.y);
    if (water < summary.minWaterContact.distance) summary.minWaterContact = { fraction, distance: water, tip: tip.toArray() };
    if (minMouth < summary.minMouthContact.distance) summary.minMouthContact = { fraction, distance: minMouth, tip: tip.toArray(), mouth: mouth.map(joint => joint.toArray()) };
    if (i % 30 === 0) samples.push({ fraction, trunkRoot: trunk[0].toArray(), trunkMid: trunk[8].toArray(), trunkTip: tip.toArray(), mouthRoot: mouth[0].toArray(), mouthTip: mouth.at(-1).toArray(), tipToMouth: minMouth });
  }
  out.clips.push({ name: clip.name, duration: clip.duration, ...summary, samples });
  mixer.stopAllAction();
}
console.log(JSON.stringify(out, null, 2));
