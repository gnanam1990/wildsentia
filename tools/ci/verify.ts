import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { testDatabaseUrl } from '../../packages/server/test/testDatabase.js';
import { assertRegressionEvidence } from './report.js';

// The gate never falls back to DATABASE_URL and never starts a world or calls a paid model.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env: NodeJS.ProcessEnv = { ...process.env, VANA_REQUIRE_TEST_DATABASE: '1' };
delete env.DATABASE_URL;
delete env.ANTHROPIC_API_KEY;
delete env.VANA_LONG_SOAK;
const run = (args: string[]): void => {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args,
    { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`Verification command failed: npm ${args.join(' ')}`);
};

async function verify(): Promise<void> {
  const url = testDatabaseUrl(env)!;
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000,
    query_timeout: 5000 });
  try {
    const { rows } = await pool.query<{ name: string }>('select current_database() as name');
    if (rows[0]?.name !== new URL(url).pathname.slice(1)) throw new Error('Database identity mismatch');
    console.log('Disposable test database identity verified. The regression suite will truncate it.');
  } catch {
    throw new Error('Test database preflight failed; verify the isolated database and credentials (details redacted)');
  } finally { await pool.end(); }

  run(['run', 'typecheck']);
  run(['exec', '--', 'tsc', '--project', 'tools/ci/tsconfig.json']);
  const artifacts = join(root, '.ci-artifacts');
  mkdirSync(artifacts, { recursive: true });
  // Each invocation gets a fresh report, so stale green output cannot satisfy this gate.
  const report = join(mkdtempSync(join(artifacts, 'regression-')), 'tests.json');
  run(['exec', '--', 'vitest', 'run', '--exclude', 'packages/runner/test/soak.test.ts',
    '--exclude', 'packages/runner/test/soak-long.test.ts', '--fileParallelism=false',
    '--reporter=default', '--reporter=json', `--outputFile.json=${report}`]);
  const result = JSON.parse(readFileSync(report, 'utf8'));
  const passed = assertRegressionEvidence(result);
  copyFileSync(report, join(artifacts, 'regression.json'));
  run(['--workspace', '@vana/client', 'run', 'build']);
  console.log(`Regression gate passed: ${passed} tests, zero skips. Ecology/release gates are separate.`);
}

void verify().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Verification failed');
  process.exitCode = 1;
});
