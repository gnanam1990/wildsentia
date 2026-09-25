import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';
import { WorldWriter } from './worldWriter.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Applies any migration not yet recorded. Returns the names applied by this call. */
export async function migrate(pool: Pool): Promise<string[]> {
  const writer = new WorldWriter(pool, () => undefined);
  try { await writer.acquire(); return await migrateOwned(writer); }
  finally { await writer.release(); }
}

/** Startup migrations must run under the same exclusive ownership as world recovery. */
export async function migrateOwned(writer: WorldWriter): Promise<string[]> {
  await writer.query(
    `create table if not exists schema_migrations (
       name text primary key, applied_at timestamptz not null default now())`,
  );

  const { rows } = await writer.query<{ name: string }>('select name from schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const applied: string[] = [];

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await writer.query('begin');
      await writer.query(sql);
      await writer.query('insert into schema_migrations (name) values ($1)', [file]);
      await writer.query('commit');
      applied.push(file);
    } catch (error) {
      await writer.query('rollback');
      throw error;
    }
  }
  return applied;
}
