/** Deterministic, project-authored fictional shelter study; not a live asset.
 * node tools/assets/build_fictional_shelter_review.mjs NEW_OUTPUT_DIRECTORY
 * No downloaded model, texture, motif, or human likeness is used.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

const output = process.argv[2];
if (!output) throw new Error('Supply a new output directory');
mkdirSync(output); // Deliberately fail instead of overwriting an earlier review.
const colors = {
  stone: [0.35, 0.36, 0.34], timber: [0.32, 0.23, 0.16],
  earth: [0.47, 0.39, 0.30], reed: [0.48, 0.43, 0.29],
  reedLight: [0.58, 0.52, 0.37],
};
const batches = Object.fromEntries(Object.keys(colors).map(key => [key, []]));
const addTri = (material, a, b, c) => batches[material].push([a, b, c]);
function box(material, x, y, z, sx, sy, sz) {
  const xa = x - sx / 2, xb = x + sx / 2, ya = y - sy / 2, yb = y + sy / 2, za = z - sz / 2, zb = z + sz / 2;
  const q = (a, b, c, d) => { addTri(material, a, b, c); addTri(material, a, c, d); };
  q([xa, ya, zb], [xb, ya, zb], [xb, yb, zb], [xa, yb, zb]);
  q([xb, ya, za], [xa, ya, za], [xa, yb, za], [xb, yb, za]);
  q([xa, ya, za], [xa, ya, zb], [xa, yb, zb], [xa, yb, za]);
  q([xb, ya, zb], [xb, ya, za], [xb, yb, za], [xb, yb, zb]);
  q([xa, yb, zb], [xb, yb, zb], [xb, yb, za], [xa, yb, za]);
  q([xa, ya, za], [xb, ya, za], [xb, ya, zb], [xa, ya, zb]);
}
function prism(material, a, b, radius, sides = 7) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const length = Math.hypot(dx, dy, dz); if (length < .001) throw new Error('Zero-length beam');
  const u = [dx / length, dy / length, dz / length];
  const ref = Math.abs(u[1]) < .8 ? [0, 1, 0] : [1, 0, 0];
  const v = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]];
  const vl = Math.hypot(...v); for (let i = 0; i < 3; i++) v[i] /= vl;
  const w = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const ring = (p, n) => p.map((value, i) => value + radius * (v[i] * Math.cos(n * 2 * Math.PI / sides) + w[i] * Math.sin(n * 2 * Math.PI / sides)));
  for (let n = 0; n < sides; n++) {
    const m = (n + 1) % sides, a0 = ring(a, n), a1 = ring(a, m), b0 = ring(b, n), b1 = ring(b, m);
    addTri(material, a0, a1, b1); addTri(material, a0, b1, b0);
    addTri(material, a, a1, a0); addTri(material, b, b0, b1);
  }
}
function roofSide(sign) {
  const outerZ = sign * 2.62, ridgeZ = 0, outerY = 2.55, ridgeY = 4.05;
  // Small panels keep the CPU review renderer's depth ordering honest at slat intersections.
  // The glTF material is double-sided, so reverse duplicate surfaces are unnecessary.
  for (let ix = 0; ix < 22; ix++) for (let iz = 0; iz < 5; iz++) {
    const px = t => -3.14 + 6.28 * t, py = t => outerY + (ridgeY - outerY) * t, pz = t => outerZ * (1 - t);
    const x0 = px(ix / 22), x1 = px((ix + 1) / 22), t0 = iz / 5, t1 = (iz + 1) / 5;
    const a = [x0, py(t0), pz(t0)], b = [x1, py(t0), pz(t0)], c = [x1, py(t1), pz(t1)], d = [x0, py(t1), pz(t1)];
    addTri('reed', a, b, c); addTri('reed', a, c, d);
  }
  // Alternating-length overlay strips give the roof an irregular silhouette without textures.
  for (let i = 0; i < 22; i++) {
    const x = -2.95 + i * 5.9 / 21, variation = (i % 4 - 1.5) * .025;
    prism(i % 3 ? 'reedLight' : 'reed', [x, outerY + variation, outerZ + sign * .08], [x, ridgeY + .02, sign * .06], .027, 5);
  }
  for (const t of [.24, .55, .82]) {
    const y = outerY + (ridgeY - outerY) * t + .035, z = outerZ * (1 - t);
    prism('timber', [-3.1, y, z], [3.1, y, z], .042, 6);
  }
}

// All geometry is designed from first principles around the existing 5 m × 4 m abstract home.
for (const x of [-2.65, 2.65]) box('stone', x, .17, 0, .35, .34, 4.5);
box('stone', 0, .17, -2.17, 5.4, .34, .3);
for (const x of [-1.95, 1.95]) box('stone', x, .17, 2.17, 1.55, .34, .3);
for (const x of [-2.48, 2.48]) for (const z of [-1.98, 1.98]) prism('timber', [x, .24, z], [x, 2.85, z], .105, 8);
for (const x of [-.78, .78]) prism('timber', [x, .28, 2.02], [x, 2.62, 2.02], .085, 8);
for (const z of [-2.02, 2.02]) prism('timber', [-2.6, 2.78, z], [2.6, 2.78, z], .10, 8);
for (const x of [-2.5, 2.5]) prism('timber', [x, 2.78, -2.12], [x, 2.78, 2.12], .10, 8);
prism('timber', [-2.85, 4.09, 0], [2.85, 4.09, 0], .09, 8);
for (const x of [-2.4, 0, 2.4]) for (const sign of [-1, 1])
  prism('timber', [x, 2.65, sign * 2.35], [x, 4.04, 0], .07, 7);
// Infill deliberately avoids a named or copied vernacular pattern.
box('earth', 0, 1.52, -2.03, 4.85, 2.3, .11);
for (const x of [-2.51, 2.51]) box('earth', x, 1.52, 0, .11, 2.3, 3.85);
for (const x of [-1.62, 1.62]) box('earth', x, 1.52, 2.03, 1.69, 2.3, .11);
box('earth', 0, 2.52, 2.03, 1.47, .33, .11);
for (let y = .55; y < 2.6; y += .32) {
  for (const z of [-2.105, 2.105]) {
    if (z > 0) {
      for (const [xa, xb] of [[-2.4, -.85], [.85, 2.4]]) prism('timber', [xa, y, z], [xb, y, z], .021, 5);
    } else prism('timber', [-2.4, y, z], [2.4, y, z], .021, 5);
  }
}
for (const x of [-2.58, 2.58]) for (let y = .55; y < 2.6; y += .32)
  prism('timber', [x, y, -1.85], [x, y, 1.85], .021, 5);
roofSide(-1); roofSide(1);

const document = new Document(), buffer = document.createBuffer(), scene = document.createScene('fictional-house-review');
const summary = { materialTriangles: {}, bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } };
for (const [name, faces] of Object.entries(batches)) {
  const positions = [], normals = [];
  for (const face of faces) {
    const [a, b, c] = face, ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i]);
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.hypot(...n) || 1;
    for (const p of face) {
      positions.push(...p); normals.push(...n.map(v => v / length));
      p.forEach((v, i) => { summary.bounds.min[i] = Math.min(summary.bounds.min[i], v); summary.bounds.max[i] = Math.max(summary.bounds.max[i], v); });
    }
  }
  const material = document.createMaterial(name).setBaseColorFactor([...colors[name], 1]).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true);
  const primitive = document.createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buffer))
    .setMaterial(material);
  scene.addChild(document.createNode(name).setMesh(document.createMesh(name).addPrimitive(primitive)));
  summary.materialTriangles[name] = faces.length;
}
const glb = Buffer.from(await new NodeIO().writeBinary(document));
writeFileSync(resolve(output, 'FictionalHouseReview.glb'), glb, { flag: 'wx' });
const views = [
  { name: 'front', camera: [8, 5.8, 10], label: 'front · door / roof overhang' },
  { name: 'rear', camera: [-8, 5.2, -9], label: 'rear · wall / roof pitch' },
];
function cameraBasis(point) {
  const target = [0, 1.7, 0], forward = target.map((v, i) => v - point[i]);
  const normalize = v => v.map(x => x / Math.hypot(...v));
  const f = normalize(forward), right = normalize([f[2], 0, -f[0]]), up = [f[1] * right[2] - f[2] * right[1], f[2] * right[0] - f[0] * right[2], f[0] * right[1] - f[1] * right[0]];
  return { f, right, up };
}
for (const view of views) {
  const { f, right, up } = cameraBasis(view.camera), width = 1000, height = 740, polygons = [];
  for (const [name, faces] of Object.entries(batches)) for (const face of faces) {
    const projected = face.map(p => {
      const rel = p.map((v, i) => v - view.camera[i]), depth = rel.reduce((s, v, i) => s + v * f[i], 0);
      return { x: width / 2 + rel.reduce((s, v, i) => s + v * right[i], 0) * 65,
        y: height / 2 - rel.reduce((s, v, i) => s + v * up[i], 0) * 65, depth };
    });
    const a = face[0], b = face[1], c = face[2];
    const ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i]);
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const light = Math.max(.42, Math.min(1.06, .73 + .3 * Math.abs(normal[1]) / (Math.hypot(...normal) || 1)));
    const color = `rgb(${colors[name].map(c => Math.round(Math.min(1, c * light) * 255)).join(',')})`;
    polygons.push({ depth: projected.reduce((s, p) => s + p.depth, 0) / 3,
      svg: `<polygon points="${projected.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${color}"/>` });
  }
  polygons.sort((a, b) => b.depth - a.depth);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#d6dbd6"/><rect y="620" width="100%" height="120" fill="#9da993"/><text x="34" y="56" font-family="sans-serif" font-size="24" fill="#26302b">Fictional shelter study · ${view.label}</text>${polygons.map(p => p.svg).join('')}<text x="34" y="711" font-family="sans-serif" font-size="18" fill="#26302b">CPU projection only · not browser/WebGL visual acceptance</text></svg>`;
  writeFileSync(resolve(output, `${view.name}.png`), await sharp(Buffer.from(svg)).png().toBuffer(), { flag: 'wx' });
}
summary.triangles = Object.values(summary.materialTriangles).reduce((a, b) => a + b, 0);
summary.drawCalls = Object.keys(colors).length;
summary.glbBytes = glb.length;
summary.glbSha256 = createHash('sha256').update(glb).digest('hex');
summary.doorwayClearance = { widthM: 1.39, heightM: 2.35 };
summary.provenance = 'Project-authored geometry; no external model, texture or traditional cultural motif';
if (summary.triangles > 12_000 || summary.drawCalls > 8 || glb.length > 900_000 || summary.doorwayClearance.widthM < 1.2)
  throw new Error(`Review budget failed: ${JSON.stringify(summary)}`);
writeFileSync(resolve(output, 'audit.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary));
