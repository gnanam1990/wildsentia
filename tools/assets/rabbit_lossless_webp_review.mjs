/** Review-only, source-preserving Rabbit GLB texture conversion. Never changes the live registry. */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const SOURCE_SHA256 = '763c19a2606208f0560386b5e207b4995b0f71f857d75ebfa7f25af04956bfa3';
const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const aligned = (n) => (n + 3) & ~3;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function unpack(bytes) {
  if (bytes.toString('utf8', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length)
    throw new Error('Expected one complete GLB 2.0');
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== GLB_JSON) throw new Error('Missing GLB JSON chunk');
  const binHeader = 20 + jsonLength;
  if (bytes.readUInt32LE(binHeader + 4) !== GLB_BIN || binHeader + 8 + bytes.readUInt32LE(binHeader) !== bytes.length)
    throw new Error('Expected a single complete GLB BIN chunk');
  return {
    gltf: JSON.parse(bytes.toString('utf8', 20, binHeader)),
    bin: bytes.subarray(binHeader + 8),
  };
}

function pack(gltf, bin) {
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonPadded = Buffer.alloc(aligned(json.length), 0x20);
  json.copy(jsonPadded);
  const binPadded = Buffer.alloc(aligned(bin.length));
  bin.copy(binPadded);
  const out = Buffer.alloc(12 + 8 + jsonPadded.length + 8 + binPadded.length);
  out.write('glTF'); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonPadded.length, 12); out.writeUInt32LE(GLB_JSON, 16);
  jsonPadded.copy(out, 20);
  const binHeader = 20 + jsonPadded.length;
  out.writeUInt32LE(binPadded.length, binHeader); out.writeUInt32LE(GLB_BIN, binHeader + 4);
  binPadded.copy(out, binHeader + 8);
  return out;
}

export async function buildRabbitLosslessWebPReview(sourceBytes) {
  if (digest(sourceBytes) !== SOURCE_SHA256) throw new Error('Rabbit source SHA-256 mismatch; inspect source before conversion');
  const { gltf, bin } = unpack(sourceBytes);
  if (gltf.buffers?.length !== 1 || gltf.images?.length !== 3 || gltf.textures?.length !== 3)
    throw new Error('Unexpected Rabbit source layout');
  const replacements = [];
  for (const [imageIndex, image] of gltf.images.entries()) {
    if (image.mimeType !== 'image/png' || image.bufferView === undefined) throw new Error('Expected embedded PNG image');
    const view = gltf.bufferViews[image.bufferView];
    if (view.buffer !== 0 || view.byteOffset % 4 !== 0) throw new Error('Expected aligned embedded image view');
    const png = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    const webp = await sharp(png).webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
    const sourcePixels = await sharp(png).ensureAlpha().raw().toBuffer();
    const derivedPixels = await sharp(webp).ensureAlpha().raw().toBuffer();
    if (!sourcePixels.equals(derivedPixels)) throw new Error(`Image ${imageIndex} is not pixel-identical`);
    replacements.push({ imageIndex, viewIndex: image.bufferView, start: view.byteOffset, end: aligned(view.byteOffset + view.byteLength), webp });
    image.mimeType = 'image/webp';
    view.byteLength = webp.length;
  }
  replacements.sort((a, b) => a.start - b.start);
  for (let i = 0; i < replacements.length; i++) {
    const current = replacements[i];
    if (current.end > (replacements[i + 1]?.start ?? bin.length)) throw new Error('Overlapping image views');
    for (const [index, view] of gltf.bufferViews.entries()) {
      if (index !== current.viewIndex && view.byteOffset >= current.start && view.byteOffset < current.end)
        throw new Error('Image replacement overlaps another buffer view');
    }
  }
  const pieces = [];
  let cursor = 0;
  for (const replacement of replacements) {
    pieces.push(bin.subarray(cursor, replacement.start));
    const padded = Buffer.alloc(aligned(replacement.webp.length));
    replacement.webp.copy(padded);
    pieces.push(padded);
    cursor = replacement.end;
  }
  pieces.push(bin.subarray(cursor));
  const newBin = Buffer.concat(pieces);
  for (const view of gltf.bufferViews) {
    const shift = replacements.reduce((sum, replacement) =>
      sum + (replacement.end <= view.byteOffset ? aligned(replacement.webp.length) - (replacement.end - replacement.start) : 0), 0);
    view.byteOffset += shift;
  }
  for (const [index, texture] of gltf.textures.entries()) {
    if (texture.source !== index || texture.extensions?.EXT_texture_webp) throw new Error('Unexpected texture mapping');
    delete texture.source;
    texture.extensions = { ...texture.extensions, EXT_texture_webp: { source: index } };
  }
  gltf.extensionsUsed = [...new Set([...(gltf.extensionsUsed ?? []), 'EXT_texture_webp'])];
  gltf.extensionsRequired = [...new Set([...(gltf.extensionsRequired ?? []), 'EXT_texture_webp'])];
  gltf.buffers[0].byteLength = newBin.length;
  return pack(gltf, newBin);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [, , sourcePath, outputPath] = process.argv;
  if (!sourcePath || !outputPath) throw new Error('Usage: node tools/assets/rabbit_lossless_webp_review.mjs SOURCE.glb OUTPUT.glb');
  const result = await buildRabbitLosslessWebPReview(await readFile(sourcePath));
  await mkdir(path.dirname(outputPath), { recursive: true });
  try { await writeFile(outputPath, result, { flag: 'wx' }); }
  catch (error) {
    if (error?.code !== 'EEXIST' || !(await readFile(outputPath)).equals(result)) throw error;
  }
  console.log(JSON.stringify({ output: outputPath, bytes: result.length, sha256: digest(result) }));
}
