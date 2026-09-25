// Geometry-only sampled side-view contact sheet; intentionally not a textured visual approval.
// Usage: node tools/assets/elephant/render_contact_sheet.mjs REVIEW.glb NEW_OUTPUT.svg [side|front] [shaded|skin]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { AnimationMixer, LoopOnce, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const [source, output, view = 'side', colourMode = 'shaded'] = process.argv.slice(2); assert(source && output);
assert(['side', 'front'].includes(view));
assert(['shaded', 'skin'].includes(colourMode));
const bytes = readFileSync(source), jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
doc.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
delete doc.images; delete doc.textures; delete doc.materials;
for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(doc), '');
const byName = new Map(); gltf.scene.traverse(node => byName.set(node.name, node));
const mesh = byName.get('Object_7'); assert(mesh?.isSkinnedMesh);
const trunk = byName.get(doc.nodes[100].name), jaw = byName.get(doc.nodes[101].name); assert(trunk && jaw);
const clip = gltf.animations.find(clip => ['DrinkingContactReview', 'DrinkingContactRegularizedReview', 'DrinkingSurfaceReview'].includes(clip.name)); assert(clip);
const mixer = new AnimationMixer(gltf.scene), action = mixer.clipAction(clip);
action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
const sampleTimes = ['DrinkingContactRegularizedReview', 'DrinkingSurfaceReview'].includes(clip.name) ? [0, .28, .7, 1.18, 1.33, 2.38] :
  [0, .28, .75, 1.37, 1.52, 2.75];
const cols = 3, width = 1200, height = 760, panelW = width / cols, panelH = height / 2;
const elements = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  '<rect width="100%" height="100%" fill="#edf4ef"/>'];
const px = (point, originX) => originX + panelW / 2 + (view === 'side' ? point.z : point.x) * 245;
const py = (y, originY) => originY + 329 - y * 278;
const format = value => value.toFixed(1);
const skinIndex = mesh.geometry.attributes.skinIndex, skinWeight = mesh.geometry.attributes.skinWeight;
const skinColour = vertex => {
  const groups = [0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const joint = skinIndex.getComponent(vertex, k), weight = skinWeight.getComponent(vertex, k);
    if (joint >= 45 && joint <= 60) groups[0] += weight;
    if (joint >= 61 && joint <= 63) groups[1] += weight;
    if (joint >= 36 && joint <= 44) groups[2] += weight;
  }
  return groups;
};
const vertexGroups = Array.from({ length: mesh.geometry.attributes.position.count }, (_, i) => skinColour(i));
for (let panel = 0; panel < sampleTimes.length; panel++) {
  const time = sampleTimes[panel], originX = panel % cols * panelW, originY = Math.floor(panel / cols) * panelH;
  action.reset().play(); mixer.setTime(time); gltf.scene.updateMatrixWorld(true); mesh.skeleton.update();
  const points = [];
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++)
    points.push(mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
  const index = mesh.geometry.index, faces = [];
  for (let i = 0; i < index.count; i += 3) {
    const indices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    const [a, b, c] = indices.map(j => points[j]);
    const ab = b.clone().sub(a), ac = c.clone().sub(a), normal = ab.cross(ac).normalize();
    const facing = view === 'side' ? normal.x : -normal.z;
    if (facing < -.04) continue;
    const light = Math.max(0, facing * .7 + normal.y * .3);
    const scores = [0, 1, 2].map(group => indices.reduce((sum, vertex) => sum + vertexGroups[vertex][group], 0) / 3);
    const dominant = scores.indexOf(Math.max(...scores));
    const category = scores[dominant] > .5 ? dominant : -1;
    faces.push({ depth: view === 'side' ? (a.x + b.x + c.x) / 3 : -(a.z + b.z + c.z) / 3,
      shade: Math.round(65 + light * 95), category, a, b, c });
  }
  faces.sort((a, b) => a.depth - b.depth);
  elements.push(`<rect x="${originX + 7}" y="${originY + 7}" width="${panelW - 14}" height="${panelH - 14}" fill="white" stroke="#b6c9b8"/>`);
  elements.push(`<line x1="${originX + 15}" y1="${format(py(0, originY))}" x2="${originX + panelW - 15}" y2="${format(py(0, originY))}" stroke="#478dc9" stroke-width="2"/>`);
  for (const face of faces) {
    const vertices = [face.a, face.b, face.c].map(point => `${format(px(point, originX))},${format(py(point.y, originY))}`).join(' ');
    const fill = colourMode === 'skin' && face.category >= 0 ? ['#31a7a1', '#bd60be', '#bd9349'][face.category] :
      `rgb(${face.shade},${face.shade + 8},${face.shade + 5})`;
    elements.push(`<polygon points="${vertices}" fill="${fill}"/>`);
  }
  const tip = trunk.getWorldPosition(new Vector3()), mouth = jaw.getWorldPosition(new Vector3());
  const distance = tip.distanceTo(mouth);
  for (const [point, color, label] of [[tip, '#df5333', 'trunk tip joint'], [mouth, '#9d45c8', 'joint 101']]) {
    elements.push(`<circle cx="${format(px(point, originX))}" cy="${format(py(point.y, originY))}" r="5" fill="${color}" stroke="white" stroke-width="1.5"/>`);
    elements.push(`<text x="${format(px(point, originX) + 9)}" y="${format(py(point.y, originY) - 7)}" font-family="sans-serif" font-size="11" fill="${color}">${label}</text>`);
  }
  elements.push(`<text x="${originX + 20}" y="${originY + 32}" font-family="sans-serif" font-size="16" font-weight="bold" fill="#173f31">t=${time.toFixed(2)}s</text>`);
  elements.push(`<text x="${originX + 20}" y="${originY + 51}" font-family="sans-serif" font-size="11" fill="#355e52">joint distance ${distance.toFixed(3)} model units; geometry-only ${view} view</text>`);
}
elements.push('</svg>');
writeFileSync(output, elements.join('\n'), { flag: 'wx' });
console.log(JSON.stringify({ output, view, colourMode, frames: sampleTimes, geometryOnly: true, texturedVisualApproval: false }));
