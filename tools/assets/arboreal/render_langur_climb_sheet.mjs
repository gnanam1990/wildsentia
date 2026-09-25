// Geometry-only side/front review of the project-authored Langur climb candidate.
// Usage: node tools/assets/arboreal/render_langur_climb_sheet.mjs REVIEW.glb NEW_OUTPUT.svg side|front
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { AnimationMixer, LoopOnce, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, output, view] = process.argv.slice(2);
assert(source && output && ['side', 'front'].includes(view));
const bytes = readFileSync(source), jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
assert.equal(doc.asset.extras?.vanaReviewOnly, true);
const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
doc.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
delete doc.images; delete doc.textures; delete doc.materials;
for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(doc), '');
const meshes = []; const joints = new Map();
gltf.scene.traverse(node => { if (node.isSkinnedMesh) meshes.push(node); joints.set(node.name, node); });
assert(meshes.length, 'skinned mesh required');
const clip = gltf.animations.find(animation => animation.name === 'ClimbReview'); assert(clip);
const mixer = new AnimationMixer(gltf.scene), action = mixer.clipAction(clip);
action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
const times = [0, .25, .5, 1, 1.5, 2];
const cols = 3, panelW = 400, panelH = 390, width = panelW * cols, height = panelH * 2;
const px = (point, originX) => view === 'side'
  ? originX + 255 + (point.z + .75) * 160
  : originX + panelW / 2 + point.x * 230;
const py = (point, originY) => originY + 346 - point.y * 230;
const format = value => value.toFixed(1);
const circle = (x, y, radius, fill) => `<circle cx="${format(x)}" cy="${format(y)}" r="${radius}" fill="${fill}" stroke="white" stroke-width="1.5"/>`;
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  '<rect width="100%" height="100%" fill="#eaf3eb"/>'];
for (let panel = 0; panel < times.length; panel++) {
  const time = times[panel], originX = panel % cols * panelW, originY = Math.floor(panel / cols) * panelH;
  action.reset().play(); mixer.setTime(time); gltf.scene.updateMatrixWorld(true);
  parts.push(`<rect x="${originX + 6}" y="${originY + 6}" width="${panelW - 12}" height="${panelH - 12}" fill="white" stroke="#b6c9b8"/>`);
  const radius = .245;
  // The tree is an illustrative cylinder. It is not part of the asset or a proof of grip.
  for (const edge of [-radius, radius]) {
    const local = new Vector3(view === 'front' ? edge : 0, 0, view === 'side' ? edge : 0);
    parts.push(`<line x1="${format(px(local, originX))}" x2="${format(px(local, originX))}" y1="${originY + 30}" y2="${originY + 340}" stroke="#ba8c5b" stroke-width="2" stroke-dasharray="4 4"/>`);
  }
  const faces = [];
  for (const mesh of meshes) {
    mesh.skeleton.update();
    const positions = [];
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++)
      positions.push(mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
    const index = mesh.geometry.index;
    for (let i = 0; i < (index?.count ?? positions.length); i += 3) {
      const indices = index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2];
      const [a, b, c] = indices.map(j => positions[j]);
      const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      const facing = view === 'side' ? normal.x : -normal.z;
      if (facing < -.03) continue;
      const shade = Math.round(74 + Math.max(0, facing * .65 + normal.y * .35) * 91);
      faces.push({ a, b, c, shade, depth: view === 'side' ? (a.x + b.x + c.x) / 3 : -(a.z + b.z + c.z) / 3 });
    }
  }
  faces.sort((a, b) => a.depth - b.depth);
  for (const face of faces) {
    const coords = [face.a, face.b, face.c].map(point => `${format(px(point, originX))},${format(py(point, originY))}`).join(' ');
    parts.push(`<polygon points="${coords}" fill="rgb(${face.shade},${face.shade + 7},${face.shade + 4})"/>`);
  }
  for (const name of ['front-1foot', 'front1foot', 'back-1foot', 'back1foot']) {
    const joint = joints.get(name); assert(joint, name);
    const point = joint.getWorldPosition(new Vector3());
    parts.push(circle(px(point, originX), py(point, originY), 4, name.startsWith('front') ? '#d34b31' : '#356dd1'));
  }
  parts.push(`<text x="${originX + 18}" y="${originY + 27}" fill="#173f31" font-family="sans-serif" font-size="16" font-weight="bold">${view} t=${time.toFixed(2)}s</text>`);
  parts.push(`<text x="${originX + 18}" y="${originY + 366}" fill="#355e52" font-family="sans-serif" font-size="11">geometry-only; dots mark joints, not finger grip</text>`);
}
parts.push('</svg>');
writeFileSync(output, parts.join('\n'), { flag: 'wx' });
console.log(JSON.stringify({ output, view, frames: times, meshPrimitives: meshes.length, geometryOnly: true,
  texturedVisualApproval: false }));
