/**
 * Opt-in, isolated PostgreSQL backup/restore drill. This creates a new local cluster and
 * three disposable databases; it never accepts or reads DATABASE_URL/TEST_DATABASE_URL.
 * Run: npm exec -- tsx tools/ops/staging-restore-drill.ts --run --port 65445
 */
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SIM_VERSION, takeSnapshot } from '@vana/sim';
import { createPool } from '../../packages/server/src/db/pool.js';
import { SimHost } from '../../packages/server/src/simHost.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
if (args.length !== 3 || args[0] !== '--run' || portArg !== 1)
  throw new Error('Explicit opt-in required: --run --port 65445');
const port = Number(args[2]);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || [5175, 8765, 65440].includes(port))
  throw new Error('Choose an unused private TCP port other than the preview/regression ports');

const sourceName = 'vana_restore_source_test';
const restoredName = 'vana_restore_target_test';
const negativeName = 'vana_restore_negative_test';
const directory = mkdtempSync(join(tmpdir(), 'vana-staging-restore-'));
const data = join(directory, 'postgres');
const dump = join(directory, 'world-and-rewards.dump');
const passwordFile = join(directory, 'password');
const password = randomBytes(24).toString('base64url');
writeFileSync(passwordFile, password, { mode: 0o600, flag: 'wx' });
const binaries = process.env.VANA_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';

function command(name: string, argv: string[], env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(join(binaries, name), argv, { encoding: 'utf8', env,
    stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${name} failed; private diagnostics retained at ${directory}`);
}

function urlFor(name: string): string {
  const url = new URL(`postgresql://vana_restore@127.0.0.1:${port}/${name}`);
  url.password = password;
  return url.href;
}

/** All work is constrained to this process's newly initialized loopback cluster and exact DB name. */
async function assertOwnedDatabase(pool: pg.Pool, expected: string): Promise<void> {
  if (![sourceName, restoredName, negativeName].includes(expected)) throw new Error('Unowned database name');
  const { rows } = await pool.query<{ name: string; port: number; address: string }>(
    'select current_database() as name, inet_server_port() as port, host(inet_server_addr()) as address');
  if (rows[0]?.name !== expected || Number(rows[0]?.port) !== port || rows[0]?.address !== '127.0.0.1')
    throw new Error('Database identity mismatch; refusing operation');
}

async function fingerprint(pool: pg.Pool): Promise<Record<string, { rows: number; sha256: string }>> {
  const names = (await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname='public' order by tablename"))
    .rows.map(row => row.tablename);
  const result: Record<string, { rows: number; sha256: string }> = {};
  for (const name of names) {
    if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected table identifier in disposable cluster');
    const rows = (await pool.query<{ payload: unknown }>(
      `select to_jsonb(t) as payload from "${name}" t order by to_jsonb(t)::text`)).rows;
    result[name] = { rows: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows.map(row => row.payload))).digest('hex') };
  }
  return result;
}

const hostOptions = (pool: pg.Pool) => ({ pool, seed: 7, speciesDir: join(root, 'config/species'),
  initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null,
  snapshotEveryWorldHours: 1 });

async function run(): Promise<void> {
  let started = false;
  try {
    command('initdb', ['-D', data, '-U', 'vana_restore', '--auth=scram-sha-256', `--pwfile=${passwordFile}`]);
    // The data path is unique; an occupied port fails instead of touching another server.
    command('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', 'start',
      '-o', `-h 127.0.0.1 -p ${port} -k ''`]);
    started = true;
    const admin = createPool(urlFor('postgres'));
    try {
      const { rows } = await admin.query<{ name: string; port: number }>(
        'select current_database() as name, inet_server_port() as port');
      if (rows[0]?.name !== 'postgres' || Number(rows[0]?.port) !== port)
        throw new Error('Private-cluster admin identity mismatch');
      for (const name of [sourceName, restoredName, negativeName]) {
        if (!/^[a-z_]+_test$/.test(name)) throw new Error('Unsafe disposable database name');
        await admin.query(`create database "${name}"`);
      }
    } finally { await admin.end(); }

    const source = createPool(urlFor(sourceName));
    let before: Record<string, { rows: number; sha256: string }>;
    let expectedSnapshot: ReturnType<typeof takeSnapshot>;
    try {
      await assertOwnedDatabase(source, sourceName);
      const host = new SimHost(hostOptions(source));
      await host.boot();
      await host.advance(1);
      expectedSnapshot = takeSnapshot(host.world);
      const actor = expectedSnapshot.agents.find(agent => agent.alive)?.id;
      if (!actor) throw new Error('Synthetic source world has no living reward subject');
      await host.stop(); // Stop the only writer before taking a consistent full-DB dump.

      const drop = '11111111-1111-4111-8111-111111111111';
      const claim = '22222222-2222-4222-8222-222222222222';
      const observer = createHash('sha256').update('disposable-observer-token').digest('hex');
      const writer = await source.connect();
      try {
        await writer.query('begin');
        await writer.query(`insert into reward_drops(id,actor_id,network,amount_micro,reveal_when,status)
          values($1,$2,'base',2500000,'watch','reserved')`, [drop, actor]);
        await writer.query(`insert into reward_claims(id,drop_id,observer_hash,wallet,status)
          values($1,$2,$3,$4,'reserved')`, [claim, drop, observer, '0x1111111111111111111111111111111111111111']);
        await writer.query(`insert into reward_audit(drop_id,claim_id,action,network)
          values($1,$2,'claim_submitted','base')`, [drop, claim]);
        await writer.query('commit');
      } catch (error) { await writer.query('rollback'); throw error; }
      finally { writer.release(); }
      before = await fingerprint(source);
      if (!before.snapshots?.rows || !before.events?.rows || before.reward_claims?.rows !== 1
        || before.reward_drops?.rows !== 1 || before.reward_audit?.rows !== 1)
        throw new Error('Source fixture lacks world, event, or reward reservation evidence');
    } finally { await source.end(); }

    command('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dump,
      '--dbname', urlFor(sourceName)]);
    for (const name of [restoredName, negativeName])
      command('pg_restore', ['--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error',
        '--dbname', urlFor(name), dump]);

    const restored = createPool(urlFor(restoredName));
    try {
      await assertOwnedDatabase(restored, restoredName);
      const after = await fingerprint(restored);
      if (JSON.stringify(after) !== JSON.stringify(before))
        throw new Error('Restored schema or row fingerprints do not match source');
      const host = new SimHost(hostOptions(restored));
      const boot = await host.boot();
      if (boot.restoredFrom !== expectedSnapshot.worldTime || boot.rolledBackEvents !== 0
        || !isDeepStrictEqual(takeSnapshot(host.world), expectedSnapshot))
        throw new Error('Restored world did not boot at the identical checkpoint');
      await host.stop();
      // Boot may create a fresh checkpoint, but must never change the reservation.
      const reward = await restored.query<{ status: string; count: string }>(
        `select status, count(*)::text as count from reward_claims group by status`);
      if (reward.rows.length !== 1 || reward.rows[0]?.status !== 'reserved' || reward.rows[0].count !== '1')
        throw new Error('First-valid reward reservation was not retained');
    } finally { await restored.end(); }

    const negative = createPool(urlFor(negativeName));
    try {
      await assertOwnedDatabase(negative, negativeName);
      let wrongDbRefused = false;
      try { await assertOwnedDatabase(negative, restoredName); }
      catch { wrongDbRefused = true; }
      if (!wrongDbRefused) throw new Error('Wrong-database guard did not fail closed');
      const changed = await negative.query(`update snapshots set sim_version='sim_drift_test',
        payload=jsonb_set(payload,'{simVersion}','"sim_drift_test"'::jsonb)
        where id=(select id from snapshots order by world_time desc,id desc limit 1)`);
      if (changed.rowCount !== 1) throw new Error('Negative fixture did not change exactly one snapshot');
      let versionRefused = false;
      try { await new SimHost(hostOptions(negative)).boot(); }
      catch (error) { versionRefused = /refusing to (boot|upgrade)/.test(String(error)); }
      if (!versionRefused) throw new Error('Unknown snapshot rules version did not fail closed');
    } finally { await negative.end(); }

    console.log(JSON.stringify({ result: 'PASS', scope: 'disposable-local-staging-style-drill',
      simVersion: SIM_VERSION, port, databases: [sourceName, restoredName, negativeName],
      tables: Object.keys(before).length, snapshots: before.snapshots?.rows, events: before.events?.rows,
      rewardReservation: 'preserved', wrongDatabase: 'refused', unknownRulesVersion: 'refused',
      diagnosticDirectory: directory }, null, 2));
  } finally {
    if (started) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    console.error(`Private staging-restore cluster ${started ? 'stopped' : 'not started'}; files retained at ${directory}`);
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Staging restore drill failed');
  process.exitCode = 1;
});
