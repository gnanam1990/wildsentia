import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { testDatabaseUrl } from './testDatabase.js';
import { readFileSync } from 'node:fs';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;

afterAll(async () => { await pool?.end(); });

maybe('migrations', () => {
  it('backfills safe deterministic event sequences but never fabricates positions or legacy ordering', async () => {
    const db = await pool!.connect();
    const sql = readFileSync(new URL('../migrations/008_event_positions.sql', import.meta.url), 'utf8');
    try {
      await db.query('begin');
      // A session-local pre-migration shape, not the shared test world's events table.
      await db.query('create temporary table events (id text primary key, type text, world_time bigint) on commit drop');
      const ids = ['born_00000001000000000000002a', 'born_00000001001fffffffffffff',
        'born_12345678', 'born_000000010020000000000000', 'born_00000001ffffffffffffffff'];
      for (const id of ids) await db.query("insert into events values ($1,'born',100)", [id]);
      await db.query(sql); await db.query(sql);
      const rows = (await db.query<{ id: string; event_sequence: string | null; position: unknown }>('select * from events')).rows;
      expect(rows.find((r) => r.id === ids[0])!.event_sequence).toBe('42');
      expect(rows.find((r) => r.id === ids[1])!.event_sequence).toBe(String(Number.MAX_SAFE_INTEGER));
      for (const id of ids.slice(2)) expect(rows.find((r) => r.id === id)!.event_sequence).toBeNull();
      expect(rows.every((r) => r.position === null)).toBe(true);
    } finally { await db.query('rollback'); db.release(); }
  });
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
