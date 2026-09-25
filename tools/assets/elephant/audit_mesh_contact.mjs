// Read-only CPU-skinned region proximity audit. Bone-index groups are from the pinned rig skin.
// Usage: node tools/assets/elephant/audit_mesh_contact.mjs MODEL.glb CLIP_NAME SECONDS
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnimationMixer, Box3, LoopOnce, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, clipName, secondsText] = process.argv.slice(2); assert(source && clipName && secondsText);
const bytes = readFileSync(source), jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
doc.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
delete doc.images; delete doc.textures; delete doc.materials;
for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(doc), '');
const clip = gltf.animations.find(clip => clip.name === clipName); assert(clip);
const time = Number(secondsText); assert(Number.isFinite(time) && time >= 0 && time <= clip.duration);
const mixer = new AnimationMixer(gltf.scene), action = mixer.clipAction(clip);
action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play(); mixer.setTime(time);
gltf.scene.updateMatrixWorld(true);
let mesh; gltf.scene.traverse(node => { if (node.name === 'Object_7') mesh = node; }); assert(mesh?.isSkinnedMesh);
mesh.skeleton.update();
const skinIndex = mesh.geometry.attributes.skinIndex, skinWeight = mesh.geometry.attributes.skinWeight;
const regions = {
  distalTrunk: { indices: new Set([57, 58, 59, 60]), minWeight: .7, vertices: [], box: new Box3() },
  proximalTrunk: { indices: new Set([45, 46, 47, 48, 49, 50, 51, 52]), minWeight: .7, vertices: [], box: new Box3() },
  inferredJaw: { indices: new Set([61, 62, 63]), minWeight: .7, vertices: [], box: new Box3() },
  tuskOrEarA: { indices: new Set([36, 37, 38, 39, 40]), minWeight: .7, vertices: [], box: new Box3() },
  tuskOrEarB: { indices: new Set([41, 42, 43, 44]), minWeight: .7, vertices: [], box: new Box3() },
};
for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
  const point = mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld);
  for (const region of Object.values(regions)) {
    let weight = 0;
    for (let k = 0; k < 4; k++) if (region.indices.has(skinIndex.getComponent(i, k))) weight += skinWeight.getComponent(i, k);
    if (weight >= region.minWeight) { region.vertices.push({ index: i, point }); region.box.expandByPoint(point); }
  }
}
const nearest = (a, b) => {
  let closest = Infinity, pair, vertexIds;
  for (const x of a.vertices) for (const y of b.vertices) {
    const d = x.point.distanceTo(y.point);
    if (d < closest) { closest = d; pair = [x.point.toArray(), y.point.toArray()]; vertexIds = [x.index, y.index]; }
  }
  return { distance: closest, vertexIds, pair };
};
const summary = Object.fromEntries(Object.entries(regions).map(([name, region]) => [name, {
  vertices: region.vertices.length, min: region.box.min.toArray(), max: region.box.max.toArray(),
}]));
console.log(JSON.stringify({ clip: clipName, time, regions: summary,
  distalToJaw: nearest(regions.distalTrunk, regions.inferredJaw),
  distalToA: nearest(regions.distalTrunk, regions.tuskOrEarA),
  distalToB: nearest(regions.distalTrunk, regions.tuskOrEarB) }, null, 2));
