/** Structural review gate only; no browser/WebGL, cultural or rights acceptance. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

const directory = process.argv[2];
if (!directory) throw new Error('Expected review directory');
const audit = JSON.parse(readFileSync(resolve(directory, 'audit.json'), 'utf8'));
const glb = readFileSync(resolve(directory, 'FictionalHouseReview.glb'));
if (createHash('sha256').update(glb).digest('hex') !== audit.glbSha256) throw new Error('GLB hash mismatch');
const document = await new NodeIO().readBinary(new Uint8Array(glb));
const primitives = document.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives());
const triangles = primitives.reduce((sum, p) => sum + p.getAttribute('POSITION').getCount() / 3, 0);
if (primitives.length !== audit.drawCalls || triangles !== audit.triangles) throw new Error('Geometry count mismatch');
if (triangles > 12_000 || glb.length > 900_000 || primitives.length > 8) throw new Error('Static budget exceeded');
for (const primitive of primitives) {
  const positions = primitive.getAttribute('POSITION').getArray();
  if (!Array.from(positions).every(Number.isFinite)) throw new Error('Nonfinite geometry');
  if (!primitive.getMaterial()?.getDoubleSided()) throw new Error('Unreviewed backface material');
}
for (const name of ['front', 'rear']) {
  const meta = await sharp(resolve(directory, `${name}.png`)).metadata();
  if (meta.width !== 1000 || meta.height !== 740 || meta.format !== 'png') throw new Error(`Invalid ${name} review image`);
}
if (audit.doorwayClearance.widthM < 1.2 || audit.doorwayClearance.heightM < 2) throw new Error('Narrow doorway');
console.log(JSON.stringify({ sha256: audit.glbSha256, triangles, drawCalls: primitives.length, bytes: glb.length, images: 2 }));
