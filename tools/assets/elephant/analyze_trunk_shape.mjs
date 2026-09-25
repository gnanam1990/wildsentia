// Read-only joint-chain geometry audit for review elephant GLBs.
// Usage: node tools/assets/elephant/analyze_trunk_shape.mjs MODEL.glb CLIP_NAME SECONDS
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnimationMixer, LoopOnce, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, clipName, secondsText] = process.argv.slice(2);
assert(source && clipName && secondsText !== undefined);
const bytes = readFileSync(source), jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
doc.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
delete doc.images; delete doc.textures; delete doc.materials;
for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(doc), '');
const byName = new Map(); gltf.scene.traverse(node => byName.set(node.name, node));
const clip = gltf.animations.find(clip => clip.name === clipName); assert(clip);
const seconds = Number(secondsText); assert(Number.isFinite(seconds) && seconds >= 0 && seconds <= clip.duration);
const mixer = new AnimationMixer(gltf.scene), action = mixer.clipAction(clip);
action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play(); mixer.setTime(seconds);
gltf.scene.updateMatrixWorld(true);
const chain = Array.from({ length: 17 }, (_, i) => byName.get(doc.nodes[84 + i].name).getWorldPosition(new Vector3()));
const jaw = byName.get(doc.nodes[101].name).getWorldPosition(new Vector3());
const direction = chain.at(-1).clone().sub(chain[0]);
const arcLength = chain.slice(1).reduce((sum, point, i) => sum + point.distanceTo(chain[i]), 0);
console.log(JSON.stringify({ clip: clipName, seconds, jaw: jaw.toArray().map(n => +n.toFixed(3)),
  tipToJaw: chain.at(-1).distanceTo(jaw), rootToTip: direction.length(), arcLength,
  chain: chain.map((point, i) => ({ joint: 84 + i, xyz: point.toArray().map(n => +n.toFixed(3)) })) }, null, 2));
