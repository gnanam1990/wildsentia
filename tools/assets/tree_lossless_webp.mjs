/** Pixel-exact leaf texture repack for the two reviewed natural broadleaf GLBs. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const SOURCES = new Map([
  ['NaturalBroadleafSpreading.glb', '00c45fa5c92e2875316569563327776a8b86910b454b65a63218d7b86d06c704'],
  ['NaturalBroadleafUpright.glb', 'aa082ce6b794117b7ecfffdb11e8d9d902cb79fb9a1a7f3d306cd17718b7c6d1'],
]);
const aligned = (n) => (n + 3) & ~3;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function unpack(bytes) {
  if (bytes.toString('utf8', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length)
    throw new Error('Expected a complete GLB 2.0');
  const jsonLength = bytes.readUInt32LE(12);
  const binHeader = 20 + jsonLength;
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || bytes.readUInt32LE(binHeader + 4) !== 0x004e4942 ||
      binHeader + 8 + bytes.readUInt32LE(binHeader) !== bytes.length)
    throw new Error('Expected one JSON and one BIN chunk');
  return { gltf: JSON.parse(bytes.toString('utf8', 20, binHeader)), bin: bytes.subarray(binHeader + 8) };
}

function pack(gltf, bin) {
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonChunk = Buffer.alloc(aligned(json.length), 0x20);
  json.copy(jsonChunk);
  const binChunk = Buffer.alloc(aligned(bin.length));
  bin.copy(binChunk);
  const out = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length);
  out.write('glTF'); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunk.length, 12); out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);
  const binHeader = 20 + jsonChunk.length;
  out.writeUInt32LE(binChunk.length, binHeader); out.writeUInt32LE(0x004e4942, binHeader + 4);
  binChunk.copy(out, binHeader + 8);
  return out;
}

export async function buildTreeLosslessWebP(sourceBytes, sourceName) {
  if (!SOURCES.has(sourceName) || digest(sourceBytes) !== SOURCES.get(sourceName))
    throw new Error('Unknown or modified broadleaf source; review it before repacking');
  const { gltf, bin } = unpack(sourceBytes);
  if (gltf.buffers?.length !== 1 || gltf.images?.length !== 9 || gltf.textures?.length !== 9)
    throw new Error('Unexpected broadleaf texture layout');
  const pngImages = gltf.images.map((image, index) => image.mimeType === 'image/png' ? index : -1).filter(index => index >= 0);
  if (pngImages.length !== 1) throw new Error('Expected one embedded leaf PNG');
  const imageIndex = pngImages[0];
  const image = gltf.images[imageIndex];
  const view = gltf.bufferViews[image.bufferView];
  if (view.buffer !== 0 || view.byteOffset % 4 !== 0 || view.byteOffset + view.byteLength > bin.length)
    throw new Error('Invalid leaf image view');
  const start = view.byteOffset, end = aligned(start + view.byteLength);
  if (end > bin.length || gltf.bufferViews.some((other, index) => index !== image.bufferView &&
    other.byteOffset >= start && other.byteOffset < end)) throw new Error('Overlapping image view');
  const png = bin.subarray(start, start + view.byteLength);
  const webp = await sharp(png).webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
  if (!(await sharp(png).ensureAlpha().raw().toBuffer()).equals(await sharp(webp).ensureAlpha().raw().toBuffer()))
    throw new Error('Leaf image decoded pixels differ');
  if (webp.length >= png.length) throw new Error('Leaf image conversion did not save bytes');
  const padded = Buffer.alloc(aligned(webp.length)); webp.copy(padded);
  const nextBin = Buffer.concat([bin.subarray(0, start), padded, bin.subarray(end)]);
  for (const other of gltf.bufferViews) if (other.byteOffset >= end) other.byteOffset += padded.length - (end - start);
  view.byteLength = webp.length;
  image.mimeType = 'image/webp';
  const linked = gltf.textures.filter(texture => texture.source === imageIndex);
  if (linked.length !== 1) throw new Error('Expected exactly one leaf texture');
  for (const texture of linked) {
    delete texture.source;
    texture.extensions = { ...texture.extensions, EXT_texture_webp: { source: imageIndex } };
  }
  gltf.extensionsUsed = [...new Set([...(gltf.extensionsUsed ?? []), 'EXT_texture_webp'])];
  gltf.extensionsRequired = [...new Set([...(gltf.extensionsRequired ?? []), 'EXT_texture_webp'])];
  gltf.buffers[0].byteLength = nextBin.length;
  return pack(gltf, nextBin);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [, , sourcePath, outputPath] = process.argv;
  if (!sourcePath || !outputPath || path.resolve(sourcePath) === path.resolve(outputPath))
    throw new Error('Usage: node tools/assets/tree_lossless_webp.mjs SOURCE.glb NEW_OUTPUT.glb');
  const result = await buildTreeLosslessWebP(await readFile(sourcePath), path.basename(sourcePath));
  try { await writeFile(outputPath, result, { flag: 'wx' }); }
  catch (error) { if (error?.code !== 'EEXIST' || !(await readFile(outputPath)).equals(result)) throw error; }
  console.log(JSON.stringify({ output: outputPath, bytes: result.length, sha256: digest(result) }));
}
