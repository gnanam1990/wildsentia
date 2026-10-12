/** Real PostgreSQL regression in a newly-created private cluster. Never opens the preview DB. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';

const directory = mkdtempSync(join(tmpdir(), 'vana-regression-'));
const binaries = process.env.VANA_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const data = join(directory, 'postgres');
const password = randomBytes(24).toString('base64url');
const passwordFile = join(directory, 'password');
writeFileSync(passwordFile, password, { mode: 0o600, flag: 'wx' });
const command = (name: string, args: string[]) => {
  const r = spawnSync(join(binaries, name), args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${name} failed; inspect ${directory} (details redacted)`);
};
let started = false;
try {
  command('initdb', ['-D', data, '-U', 'vana_test', '--auth=scram-sha-256', `--pwfile=${passwordFile}`]);
  // Choose an available loopback port; never stop or repurpose another test cluster.
  const probe = createServer();
  const port = await new Promise<number>((done, fail) => {
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') fail(new Error('No local PostgreSQL port'));
      else probe.close(() => done(address.port));
    });
  });
  command('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', 'start', '-o', `-h 127.0.0.1 -p ${port} -k ''`]);
  started = true;
  const url = new URL(`postgresql://vana_test@127.0.0.1:${port}/postgres`); url.password = password;
  const pool = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  try { await pool.query('create database vana_regression_test'); } finally { await pool.end(); }
  url.pathname = '/vana_regression_test';
  const env: NodeJS.ProcessEnv = { ...process.env, TEST_DATABASE_URL: url.href, VANA_REQUIRE_TEST_DATABASE: '1' };
  delete env.DATABASE_URL; delete env.ANTHROPIC_API_KEY;
  for (const key of ['OPENROUTER_API_KEY','LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','VANA_SAFARI_LIVEKIT','VANA_LEAGUE_PUBLIC_MODELS']) delete env[key];
  // Optional file arguments run only the named focused tests against this same
  // isolated database; no argument preserves the full CI gate.
  const files = process.argv.slice(2);
  const commandArgs = files.length ? ['test', '--', '--run', ...files] : ['run', 'verify:ci'];
  const result = spawnSync('npm', commandArgs, { cwd: resolve(import.meta.dirname, '../..'), env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  if (started) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  console.log(`Regression cluster ${started ? 'stopped' : 'not started'}; private diagnostic files retained at ${directory}`);
}
