/** Fetch reviewed CC0 tree source data, never execute downloaded scene scripts.
 * Usage: node tools/assets/download_polyhaven.mjs ASSET_ID SCRATCH_DIRECTORY
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';

const [id, directory] = process.argv.slice(2);
if (!['island_tree_02', 'tree_small_02'].includes(id) || !directory) throw new Error('Expected a reviewed tree ID and scratch directory');
const root = resolve(directory, id);
await mkdir(root, { recursive: true });
const response = await fetch(`https://api.polyhaven.com/files/${id}`);
if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
const manifest = await response.json();
const source = manifest.blend['1k'].blend;
const reviewed = { island_tree_02: 'eeacbddb0ae5ceafa70115d066f21178', tree_small_02: 'd602d9e4df77457454ac427fd37d0b53' };
if (source.md5 !== reviewed[id]) throw new Error('Publisher source changed; review it before conversion');
const files = [[`${id}_1k.blend`, source], ...Object.entries(source.include)];
for (const [name, file] of files) {
  const target = resolve(root, name);
  if (!target.startsWith(root + sep)) throw new Error('Unsafe include path');
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || url.hostname !== 'dl.polyhaven.org') throw new Error('Unexpected asset origin');
  let data;
  try { data = await readFile(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (data && createHash('md5').update(data).digest('hex') !== file.md5) throw new Error(`Existing file differs: ${target}`);
  if (!data) {
    const download = await fetch(url);
    if (!download.ok) throw new Error(`Download HTTP ${download.status}: ${name}`);
    data = Buffer.from(await download.arrayBuffer());
    if (data.length !== file.size || createHash('md5').update(data).digest('hex') !== file.md5) throw new Error(`Integrity mismatch: ${name}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }
  console.log(`${id}: ${name} · ${data.length} bytes · publisher MD5 verified`);
}
console.log(`Source ready: ${root}. Run Blender with --disable-autoexec.`);
