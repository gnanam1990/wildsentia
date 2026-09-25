/** Isolated, durable local preview. Never uses DATABASE_URL or model credentials.
 * npm exec tsx tools/preview/local.ts [existing .local-preview/world-* directory]
 * PostgreSQL binaries: VANA_PG_BIN or Homebrew PostgreSQL 17. All listeners are loopback.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createPool } from '../../packages/server/src/db/pool.js';
import { SimHost } from '../../packages/server/src/simHost.js';
import { buildApi } from '../../packages/server/src/api.js';
import { Narrator } from '../../packages/server/src/narration/narrator.js';
import { Gateway } from '../../packages/server/src/gateway.js';
import { parsePreviewConfig, previewPorts } from './config.js';
import type { TerrainProfile } from '@vana/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const previewRoot = join(root, '.local-preview');
mkdirSync(previewRoot, { recursive: true, mode: 0o700 });
const fresh = !process.argv[2];
const requestedProfile = process.env.VANA_PREVIEW_TERRAIN_PROFILE;
const freshProfile = (requestedProfile ?? 'mainland') as TerrainProfile;
const freshPorts = previewPorts(freshProfile);
const directory = fresh ? mkdtempSync(join(previewRoot, 'world-')) : realpathSync(resolve(process.argv[2]!));
if (!directory.startsWith(realpathSync(previewRoot) + sep)) throw new Error('Preview directory must be inside .local-preview');
const pgBin = process.env.VANA_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const configPath = join(directory, 'connection.json');
if (fresh) writeFileSync(configPath, JSON.stringify({ version: 3, port: freshPorts.database, terrainProfile: freshProfile,
  communityProfile: freshProfile === 'island_v1' ? 'household_v1' : 'none',
  password: randomBytes(24).toString('base64url') }), { flag: 'wx', mode: 0o600 });
if ((statSync(configPath).mode & 0o077) !== 0) throw new Error('Preview credentials must be private (0600)');
const config = parsePreviewConfig(JSON.parse(readFileSync(configPath, 'utf8')), requestedProfile);
const data = join(directory, 'postgres');
const command = (name: string, args: string[]) => {
  const result = spawnSync(join(pgBin, name), args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${name} failed; inspect the local preview PostgreSQL log`);
};
if (fresh) {
  const passwordFile = join(directory, 'pg-password');
  writeFileSync(passwordFile, config.password, { flag: 'wx', mode: 0o600 });
  command('initdb', ['-D', data, '-U', 'vana_preview', '--auth=scram-sha-256', `--pwfile=${passwordFile}`]);
} else if (!existsSync(join(data, 'PG_VERSION')) || realpathSync(data) !== data) {
  throw new Error('Missing or unexpected preview database directory');
}
let startedPg = false;
let pool: ReturnType<typeof createPool> | undefined;
let host: SimHost | undefined;
let api: ReturnType<typeof buildApi> | undefined;
let gateway: Gateway | undefined;
let server: ReturnType<typeof createServer> | undefined;
let vite: ChildProcess | undefined;
let timer: NodeJS.Timeout | undefined;
let closing: Promise<void> | undefined;
let stage = 'database startup';
const close = (): Promise<void> => closing ??= (async () => {
  if (timer) clearInterval(timer);
  vite?.kill('SIGTERM'); gateway?.close();
  try { await host?.stop(); } finally {
    if (server?.listening) await new Promise<void>((done) => server!.close(() => done()));
    try { await api?.close(); } finally { await pool?.end(); }
    if (startedPg) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  }
})();
try {
  const running = spawnSync(join(pgBin, 'pg_ctl'), ['-D', data, 'status'], { stdio: 'ignore' }).status === 0;
  if (!running) {
    command('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', 'start',
      '-o', `-h 127.0.0.1 -p ${config.ports.database} -k ''`]);
    startedPg = true;
  }
  const url = new URL(`postgresql://vana_preview@127.0.0.1:${config.ports.database}/postgres`);
  url.password = config.password;
  if (fresh) {
    const admin = createPool(url.href);
    try { await admin.query('create database vana_preview'); } finally { await admin.end(); }
  }
  url.pathname = '/vana_preview'; pool = createPool(url.href);
  stage = 'world boot';
  host = new SimHost({ pool, seed: 1, speciesDir: join(root, 'config/species'), worldHoursPerRealHour: 1,
    terrainProfile: config.profile, communityProfile: config.communityProfile });
  const boot = await host.boot();
  stage = 'first morning advance';
  if (fresh) await host.advance(10); // A genuinely simulated first morning, not forged world state.
  stage = 'API setup';
  api = buildApi({ host, pool, narrator: new Narrator({ pool, rephrase: null, dailyTokenBudget: 0 }) });
  await api.ready();
  server = createServer((request, response) => api!.server.emit('request', request, response));
  stage = 'API listener';
  await new Promise<void>((done, fail) => {
    server!.once('error', fail); server!.listen(config.ports.api, '127.0.0.1', () => { server!.removeListener('error', fail); done(); });
  });
  gateway = new Gateway(host); gateway.attach(server); host.start();
  stage = 'client startup';
  timer = setInterval(() => gateway!.broadcast(), 1000);
  const clientRequire = createRequire(join(root, 'packages/client/package.json'));
  const viteCli = join(dirname(clientRequire.resolve('vite/package.json')), 'bin/vite.js');
  vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(config.ports.client), '--strictPort'],
    { cwd: join(root, 'packages/client'), env: { ...process.env, VANA_API_PORT: String(config.ports.api) }, stdio: 'inherit' });
  vite.on('exit', () => { if (!closing) void close().then(() => process.exit(1)); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().then(() => process.exit(0)); });
  console.log(fresh ? 'Fresh isolated preview: simulated to morning; template narration only.' : `Restored isolated preview at ${boot.restoredFrom}.`);
  console.log(`Preview (${config.profile}, ${config.communityProfile}): http://127.0.0.1:${config.ports.client}/?stats\nDurable local directory: ${directory}`);
} catch (error) {
  const safeMessage = (error instanceof Error ? error.message : 'unknown error').replaceAll(config.password, '[redacted]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted database URL]');
  console.error(`Local preview failed during ${stage}: ${safeMessage}. No external database or paid model was used.`);
  await close(); process.exitCode = 1;
}
