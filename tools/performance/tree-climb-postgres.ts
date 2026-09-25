/** Opt-in, disposable PostgreSQL storage/read probe for retained tree routes.
 * Example: npm exec tsx tools/performance/tree-climb-postgres.ts --run --rows 100000 --port 65444
 * Never reads DATABASE_URL, never connects to a preview world, never deletes the private cluster.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { treeAnchorForPatch, type WorldEvent } from '@vana/shared';
import { createWorld, SIM_VERSION } from '../../packages/sim/src/world.js';
import { createPool } from '../../packages/server/src/db/pool.js';
import { migrate } from '../../packages/server/src/db/migrate.js';
import { EventStore } from '../../packages/server/src/db/eventStore.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
if (!args.includes('--run')) throw new Error('Opt-in required: --run --rows 100000 --port 65444');
const rows = Number(option('--rows') ?? 100_000), port = Number(option('--port') ?? 65444);
if (!Number.isSafeInteger(rows) || rows < 1_000 || rows > 100_000
  || !Number.isSafeInteger(port) || port < 1024 || port > 65535)
  throw new Error('Use 1,000–100,000 rows and a valid non-privileged port');
for (const arg of args) if (!['--run', '--rows', '--port', '--output'].includes(arg)
  && !args.some(flag => ['--rows', '--port', '--output'].includes(flag) && option(flag) === arg))
  throw new Error(`Unknown argument: ${arg}`);

const directory = mkdtempSync(join(tmpdir(), 'vana-tree-pg-'));
const binaries = process.env.VANA_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const data = join(directory, 'postgres'), passwordFile = join(directory, 'password');
const password = randomBytes(24).toString('base64url');
writeFileSync(passwordFile, password, { mode: 0o600, flag: 'wx' });
const command = (name: string, argv: string[]): void => {
  const result = spawnSync(join(binaries, name), argv, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${name} failed; inspect private cluster log in ${directory}`);
};
const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
};
const actorId = (index: number): string => {
  const slot = index % 128;
  return `${slot % 5 === 0 ? 'squirrel' : 'langur'}_bench_${String(slot).padStart(3, '0')}`;
};
const eventId = (index: number): string => `tree_bench_${(index + 1).toString(16).padStart(24, '0')}`;
const worldTime = (index: number, count: number, duration: number): number =>
  Math.floor(index * 360 * 24 / count) * 3600 + duration;
type Anchor = NonNullable<ReturnType<typeof treeAnchorForPatch>>;
function syntheticEvent(index: number, count: number, anchors: readonly Anchor[]): WorldEvent {
  const anchor = anchors[index % anchors.length]!, n = index === count - 1 ? 2048 : [8, 16, 32][index % 3]!;
  const step = n === 2048 ? 1 : 2, duration = (n - 1) * step, startWorldTime = worldTime(index, count, 0);
  const direction = index % 10 === 0 ? 'descend' : 'ascend';
  const approachOnly = direction === 'ascend' && index % 10 === 1;
  const samples = Array.from({ length: n }, (_, j) => {
    const position = { x: approachOnly ? anchor.x - 4 + j * 3.8 / (n - 1)
      : direction === 'ascend' && j === 0 ? anchor.x - 4 : anchor.x, z: anchor.z, heading: 0 };
    const altitudeM = direction === 'descend' ? 6 * (1 - j / (n - 1))
      : j === 0 || approachOnly ? undefined : 6 * (j - 1) / (n - 2);
    return { seconds: j * step, position, ...(altitudeM === undefined ? {} : { altitudeM }) };
  });
  const last = samples.at(-1)!;
  return { id: eventId(index), type: 'tree_climbed', worldTime: startWorldTime + duration,
    simVersion: SIM_VERSION, patchId: anchor.patchId, actors: [actorId(index)], goal: direction === 'ascend' ? 'flee' : 'rest',
    conditions: { direction, treeAnchorId: anchor.id, reason: direction === 'ascend' ? 'local_threat' : 'threat_gone',
      from: anchor.patchId, destination: anchor.patchId }, outcome: approachOnly ? 'interrupted' : 'success',
    effects: { verticalDistanceM: approachOnly ? 0 : 6, horizontalDistanceM: approachOnly || direction === 'ascend' ? 4 : 0,
      distanceM: (approachOnly || direction === 'ascend' ? 4 : 0) + (approachOnly ? 0 : 6), durationSeconds: duration,
      sprintSeconds: direction === 'ascend' ? duration : 0 }, causalParents: [], confidence: 'authoritative',
    position: last.position,
    movement: { version: 1, actorId: actorId(index), startWorldTime, destinationPatchId: anchor.patchId,
      goal: direction === 'ascend' ? 'flee' : 'rest', completed: !approachOnly, samples } };
}

async function run(): Promise<void> {
  let started = false;
  try {
    const output = option('--output');
    if (output && existsSync(resolve(root, output))) throw new Error('Output already exists; choose a fresh evidence path');
    command('initdb', ['-D', data, '-U', 'vana_perf', '--auth=scram-sha-256', `--pwfile=${passwordFile}`]);
    // This dedicated directory and port are the only process targets. A conflict fails closed.
    command('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', 'start',
      '-o', `-h 127.0.0.1 -p ${port} -k ''`]);
    started = true;
    const url = new URL(`postgresql://vana_perf@127.0.0.1:${port}/postgres`);
    url.password = password;
    const admin = new pg.Pool({ connectionString: url.href, max: 1 });
    try { await admin.query('create database vana_climb_perf_test'); } finally { await admin.end(); }
    url.pathname = '/vana_climb_perf_test';
    const pool = createPool(url.href);
    try {
      await migrate(pool);
      const speciesDir = join(root, 'config/species');
      const world = createWorld({ seed: 1, speciesDir, terrainProfile: 'island_v1', initialAgents: {}, minPopulation: {} });
      const anchors = world.patches.map(p => treeAnchorForPatch(p)).filter((a): a is Anchor => a !== null);
      if (!anchors.length) throw new Error('No tree-eligible island patches');
      const store = new EventStore(pool);
      const insertStarted = performance.now();
      for (let start = 0; start < rows; start += 500) {
        const batch = Array.from({ length: Math.min(500, rows - start) }, (_, offset) => syntheticEvent(start + offset, rows, anchors));
        await store.appendBatch(batch);
        if ((start + batch.length) % 10_000 === 0) process.stderr.write(`Inserted ${start + batch.length}/${rows} synthetic climb events\n`);
      }
      const insertMs = performance.now() - insertStarted;
      await pool.query('vacuum analyze events');
      const sizes = await pool.query<{ table_bytes: string; index_bytes: string; total_bytes: string; count: string }>(
        `select pg_relation_size('events') as table_bytes, pg_indexes_size('events') as index_bytes,
          pg_total_relation_size('events') as total_bytes, (select count(*) from events) as count`);
      if (Number(sizes.rows[0]?.count) !== rows) throw new Error('Inserted row count mismatch');
      const indexes = await pool.query<{ indexrelname: string; bytes: string }>(
        `select indexrelname, pg_relation_size(indexrelid) as bytes from pg_stat_user_indexes
         where relname = 'events' order by indexrelname`);
      const sample = await pool.query<{ avg_bytes: string; min_bytes: number; max_bytes: number }>(
        `select avg(pg_column_size(movement))::text as avg_bytes,
          min(pg_column_size(movement)) as min_bytes, max(pg_column_size(movement)) as max_bytes
         from (select movement from events limit 1000) sample`);
      const boundary = { worldTime: 360 * 86_400 + 3600, nextSequence: rows + 100 };
      const routeTimes: number[] = [], worstRouteTimes: number[] = [], firstPageTimes: number[] = [], deepPageTimes: number[] = [];
      const measure = async (times: number[], action: () => Promise<unknown>, warmups = 20): Promise<void> => {
        for (let i = 0; i < warmups; i++) await action();
        for (let i = 0; i < 200; i++) {
          const startedAt = process.hrtime.bigint(); await action();
          times.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
        }
      };
      const selected = async (i: number) => {
        const found = await store.climbById(actorId(i), eventId(i), boundary);
        if (!found || found.id !== eventId(i)) throw new Error(`Synthetic direct lookup failed at row ${i}`);
      };
      const page = async (i: number, after?: { worldTime: number; id: string }) => {
        const result = await store.page({ actorId: actorId(i), boundary, limit: 25, descending: true,
          summary: true, ...(after ? { after } : {}) });
        if (result.events.length === 0 || result.events.some(event => event.movement !== undefined))
          throw new Error(`Synthetic actor summary page failed at row ${i}`);
      };
      let iteration = 0;
      await measure(routeTimes, () => selected((iteration++ * 499) % rows));
      await measure(worstRouteTimes, () => selected(rows - 1), 5);
      iteration = 0;
      await measure(firstPageTimes, () => page(iteration++ % 128));
      iteration = 0;
      await measure(deepPageTimes, () => { const actor = iteration++ % 128;
        const i = Math.floor(rows / 2 / 128) * 128 + actor;
        return page(i, { worldTime: worldTime(i, rows, ([8, 16, 32][i % 3]! - 1) * 2), id: eventId(i) }); });
      const representative = Math.floor(rows / 2);
      const directPlan = await pool.query<{ 'QUERY PLAN': Array<Record<string, unknown>> }>(
        `explain (analyze, buffers, format json) select * from events where id = $1 and type = 'tree_climbed'
         and actors @> array[$2]::text[] and (world_time < $3 or (world_time = $3 and event_sequence < $4))`,
        [eventId(representative), actorId(representative), boundary.worldTime, boundary.nextSequence]);
      const deepIndex = Math.floor(rows / 2 / 128) * 128;
      const pagePlan = await pool.query<{ 'QUERY PLAN': Array<Record<string, unknown>> }>(
        `explain (analyze, buffers, format json) select id, type, world_time, sim_version, patch_id, actors, goal,
         conditions, outcome, effects, causal_parents, confidence, position, null::jsonb as encounter,
         null::jsonb as movement, (encounter is not null) as has_encounter,
         (type = 'tree_climbed' and movement is not null) as has_climb from events
         where actors @> array[$1]::text[] and world_time < $2
         and (world_time, id collate "C") < ($3::bigint, $4::text collate "C")
         order by world_time desc, id collate "C" desc limit 26`,
        [actorId(deepIndex), boundary.worldTime, worldTime(deepIndex, rows, ([8, 16, 32][deepIndex % 3]! - 1) * 2), eventId(deepIndex)]);
      const metrics = (values: number[]) => ({ samples: values.length, medianMs: percentile(values, .5),
        p95Ms: percentile(values, .95), p99Ms: percentile(values, .99), maxMs: Math.max(...values) });
      const report = { scope: 'synthetic retained tree_climbed PostgreSQL storage/read probe; not production or device load',
        rows, port, simVersion: SIM_VERSION, anchorPatches: anchors.length,
        shape: { actors: 128, yearDays: 360, sampleCounts: [8, 16, 32],
          stressRows2048Samples: 1, pattern: 'roughly 80% ascent, 10% descent, 10% approach-only; one 2048-sample extreme' },
        insertionMs: insertMs, tableBytes: Number(sizes.rows[0]!.table_bytes), indexBytes: Number(sizes.rows[0]!.index_bytes),
        totalBytes: Number(sizes.rows[0]!.total_bytes), count: Number(sizes.rows[0]!.count),
        indexes: indexes.rows.map(row => ({ name: row.indexrelname, bytes: Number(row.bytes) })),
        movementDatumSample: { n: 1000, averageBytes: Number(sample.rows[0]!.avg_bytes),
          minBytes: sample.rows[0]!.min_bytes, maxBytes: sample.rows[0]!.max_bytes },
        timings: { directSelected: metrics(routeTimes), direct2048Sample: metrics(worstRouteTimes),
          actorFirstPage: metrics(firstPageTimes), actorDeepPage: metrics(deepPageTimes) },
        plans: { directSelected: directPlan.rows[0]!['QUERY PLAN'][0], actorDeepPage: pagePlan.rows[0]!['QUERY PLAN'][0] },
        environment: { node: process.version, platform: process.platform, arch: process.arch,
          postgres: (await pool.query<{ version: string }>('select version()')).rows[0]!.version },
      };
      if (output) {
        const path = resolve(root, output);
        writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
        console.log(`Wrote non-secret report: ${path}`);
      } else console.log(JSON.stringify(report, null, 2));
      console.log(`Private diagnostic cluster files retained at ${directory}; do not publish its password file.`);
    } finally { await pool.end(); }
  } finally {
    if (started) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    console.log(`Private PostgreSQL cluster ${started ? 'stopped' : 'not started'}.`);
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Climb storage probe failed');
  process.exitCode = 1;
});
