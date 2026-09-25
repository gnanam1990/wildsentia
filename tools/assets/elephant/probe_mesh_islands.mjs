// Read-only connected-component inventory of the pinned elephant skin.
// Usage: node tools/assets/elephant/probe_mesh_islands.mjs MODEL.glb
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const source = process.argv[2]; assert(source);
const bytes = readFileSync(source), jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
doc.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
delete doc.images; delete doc.textures; delete doc.materials;
for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(doc), '');
gltf.scene.updateMatrixWorld(true);
let mesh; gltf.scene.traverse(node => { if (node.isSkinnedMesh) mesh = node; }); assert(mesh);
mesh.skeleton.update();
const geometry = mesh.geometry, index = geometry.index; assert(index);
const parent = Uint32Array.from({ length: geometry.attributes.position.count }, (_, i) => i);
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
for (let i = 0; i < index.count; i += 3) {
  const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
  union(a, b); union(b, c);
}
const components = new Map();
for (let i = 0; i < parent.length; i++) {
  const root = find(i);
  let item = components.get(root);
  if (!item) { item = { root, vertices: 0, triangles: 0, box: new Box3() }; components.set(root, item); }
  item.vertices++;
  item.box.expandByPoint(mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
}
for (let i = 0; i < index.count; i += 3) components.get(find(index.getX(i))).triangles++;
console.log(JSON.stringify([...components.values()].sort((a, b) => b.triangles - a.triangles).map(c => ({
  root: c.root, vertices: c.vertices, triangles: c.triangles,
  min: c.box.min.toArray().map(x => +x.toFixed(3)),
  max: c.box.max.toArray().map(x => +x.toFixed(3)),
})), null, 2));
