import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;

afterAll(async () => { await pool?.end(); });

maybe('migrations', () => {
  it('applies every migration and is idempotent', async () => {
    const first = await migrate(pool!);
    expect(first.length + (await pool!.query("select 1 from schema_migrations where name = '001_init.sql'")).rowCount!)
      .toBeGreaterThan(0);
    expect(await migrate(pool!)).toEqual([]);
  });

  it('creates the tables the server needs', async () => {
    await migrate(pool!);
    const { rows } = await pool!.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const table of ['events', 'snapshots', 'viewers', 'follows', 'schema_migrations']) {
      expect(names).toContain(table);
    }
  });
});
