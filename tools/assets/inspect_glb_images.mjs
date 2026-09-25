/** Extract embedded images to a scratch directory for visual export QA. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [source, target] = process.argv.slice(2);
const bytes = readFileSync(source), length = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + length));
mkdirSync(target, { recursive: true });
for (const [i, image] of gltf.images.entries()) {
  const view = gltf.bufferViews[image.bufferView];
  const start = 28 + length + (view.byteOffset ?? 0);
  const path = join(target, `${i}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`);
  writeFileSync(path, bytes.subarray(start, start + view.byteLength));
  console.log(i, image.name, path);
}
