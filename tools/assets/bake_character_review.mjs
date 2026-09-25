// Diagnostic static pose only; never use this output as a rigged runtime replacement.
// Uses the game's Three.js skinning to distinguish source problems from Blender import issues.
import { readFileSync, writeFileSync } from 'node:fs';
import { AnimationMixer, Vector3, Float32BufferAttribute } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, output, meshName, clipName, seconds = '0'] = process.argv.slice(2);
if (!source || !output || !meshName || !clipName || !Number.isFinite(Number(seconds)) || Number(seconds) < 0)
  throw new Error('Usage: INPUT.glb NEW_OUTPUT.glb EXACT_MESH EXACT_CLIP NONNEGATIVE_SECONDS');
const input = readFileSync(source);
if (input.toString('ascii', 0, 4) !== 'glTF' || input.readUInt32LE(4) !== 2 || input.readUInt32LE(8) !== input.length)
  throw new Error('Expected complete GLB v2');
const jsonLength = input.readUInt32LE(12);
const original = JSON.parse(input.subarray(20, 20 + jsonLength).toString());
if (original.buffers.length !== 1 || original.buffers[0].uri) throw new Error('Embedded single-buffer GLB required');
const binary = input.subarray(28 + jsonLength, 28 + jsonLength + original.buffers[0].byteLength);
const load = structuredClone(original);
load.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
// Geometry-only loading avoids browser image APIs. The output preserves original embedded images.
delete load.images; delete load.textures; delete load.materials;
for (const mesh of load.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(load), '');
const matches = [];
gltf.scene.traverse((o) => { if (o.name === meshName && o.isSkinnedMesh) matches.push(o); });
if (matches.length !== 1) throw new Error(`Expected exactly one skinned mesh named ${meshName}`);
const mesh = matches[0];
const association = gltf.parser.associations.get(mesh);
const primitives = original.meshes[association.meshes].primitives;
if (primitives.length !== 1 || (primitives[0].mode ?? 4) !== 4 || mesh.morphTargetInfluences?.length)
  throw new Error('Review currently supports one triangle primitive without morph targets');
const clip = gltf.animations.find((a) => a.name === clipName);
if (!clip) throw new Error(`Missing clip ${clipName}`);
const mixer = new AnimationMixer(gltf.scene);
mixer.clipAction(clip).play(); mixer.setTime(Number(seconds));
gltf.scene.updateMatrixWorld(true); mesh.skeleton.update();
const geometry = mesh.geometry.clone();
const positions = new Float32Array(geometry.attributes.position.count * 3);
const point = new Vector3();
for (let i = 0; i < positions.length / 3; i++) {
  mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
  if (!point.toArray().every(Number.isFinite)) throw new Error('Non-finite posed vertex');
  positions.set(point.toArray(), i * 3);
}
geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
geometry.computeVertexNormals(); geometry.computeBoundingBox();
const chunks = [binary, Buffer.alloc((4 - binary.length % 4) % 4)];
let offset = chunks.reduce((sum, b) => sum + b.length, 0);
function appendAttribute(attribute, bounds) {
  const bytes = Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength);
  const bufferView = original.bufferViews.length;
  original.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 });
  chunks.push(bytes); offset += bytes.length;
  const index = original.accessors.length;
  original.accessors.push({ bufferView, componentType: 5126, count: attribute.count, type: 'VEC3', ...bounds });
  return index;
}
const primitive = structuredClone(primitives[0]);
primitive.attributes.POSITION = appendAttribute(geometry.attributes.position, {
  min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray(),
});
primitive.attributes.NORMAL = appendAttribute(geometry.attributes.normal);
for (const key of Object.keys(primitive.attributes)) if (/^(JOINTS_|WEIGHTS_|TANGENT)/.test(key)) delete primitive.attributes[key];
original.meshes = [{ name: `${meshName} ${clipName} ${seconds}s review`, primitives: [primitive] }];
original.nodes = [{ mesh: 0 }]; original.scenes = [{ nodes: [0] }]; original.scene = 0;
delete original.skins; delete original.animations; delete original.cameras;
original.buffers = [{ byteLength: offset }];
original.asset.extras = { ...original.asset.extras, reviewOnly: true, pose: { meshName, clipName, seconds: Number(seconds) } };
const rawJson = Buffer.from(JSON.stringify(original));
const json = Buffer.concat([rawJson, Buffer.alloc((4 - rawJson.length % 4) % 4, 32)]);
const bin = Buffer.concat(chunks);
const header = Buffer.alloc(20);
header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + bin.length, 8);
header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4);
writeFileSync(output, Buffer.concat([header, json, binHeader, bin]), { flag: 'wx' });
console.log(JSON.stringify({ output, bounds: geometry.boundingBox, vertices: positions.length / 3, reviewOnly: true }));
