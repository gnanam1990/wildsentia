/** Public, anonymous Standard downloads only. No payment, account, quarantine bypass or source kit. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const [slug, directory] = process.argv.slice(2);
if (!['universal-base-characters', 'modular-character-outfits-fantasy', 'universal-animation-library'].includes(slug) || !directory)
  throw new Error('usage: download_quaternius_standard.mjs ALLOWED_SLUG NEW_DIRECTORY');
const base = `https://quaternius.itch.io/${slug}`, cookies = new Map();
async function request(url, body) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(120000),
    headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), Referer: base,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } : {}) },
    ...(body ? { body: new URLSearchParams(body) } : {}) });
  for (const line of response.headers.getSetCookie()) { const [key, ...value] = line.split(';')[0].split('='); cookies.set(key, value.join('=')); }
  if (!response.ok) throw new Error(`publisher request failed: ${response.status}`);
  return response;
}
const csrf = html => {
  const token = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  if (!token) throw new Error('publisher form token missing'); return token;
};
const page = await (await request(base)).text();
const download = await (await request(`${base}/download_url`, { csrf_token: csrf(page) })).json();
if (!download.url || download.errors || !download.url.startsWith(`${base}/download/`)) throw new Error('free download page unavailable');
const html = await (await request(download.url)).text();
const uploads = [...html.matchAll(/data-upload_id="(\d+)"[^]*?<strong class="name" title="([^"]+)"/g)]
  .filter(([, , name]) => name.includes('[Standard]') && name.endsWith('.zip'));
if (uploads.length !== 1) throw new Error('exactly one free Standard archive required');
const [, upload, filename] = uploads[0];
const result = await (await request(`${base}/file/${upload}?source=game_download`, { csrf_token: csrf(html) })).json();
if (result.errors || result.lightbox || !result.url || !result.url.startsWith('https://') || result.external)
  throw new Error('download not directly available; no gate or quarantine bypass attempted');
const response = await fetch(result.url, { signal: AbortSignal.timeout(120000) });
if (!response.ok || Number(response.headers.get('content-length')) > 512 * 1024 * 1024) throw new Error('archive unavailable or over budget');
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length > 512 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('not a bounded ZIP archive');
const output = resolve(directory); await mkdir(output); // new directory only, never replace an existing download
await writeFile(join(output, 'standard.zip'), bytes, { flag: 'wx' });
const manifest = { source: base, filename, uploadId: upload, bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') };
await writeFile(join(output, 'download.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory: output, ...manifest }, null, 2));
