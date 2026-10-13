import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SimHost } from './trackedHost.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { EventStore } from '../src/db/eventStore.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { Gateway } from '../src/gateway.js';
import { startServer } from '../src/index.js';
import { createServer } from 'node:http';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null;
const maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 2,
  speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: { sambar: 10 }, minPopulation: {}, landscape: null,
  snapshotEveryWorldHours: 24 });
afterAll(async () => { await pool?.end(); });

maybe('exclusive durable world writer', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
  });

  it('waits a while for the writer lock when told to, so a new deployment boots once the old one lets go', async () => {
    const old = new SimHost(options());
    await old.boot();
    const next = new SimHost({ ...options(), writerWaitMs: 5000 });
    const booting = next.boot();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(next.isWriterActive).toBe(false);
    await old.stop();
    await booting;
    expect(next.isWriterActive).toBe(true);
    await next.stop();
  });

  it('refuses unbooted writes and permits only one of two concurrent boots', async () => {
    const a = new SimHost(options()), b = new SimHost(options());
    await expect(a.advance(1)).rejects.toThrow('writer');
    await expect(a.snapshotNow()).rejects.toThrow('writer');
    const results = await Promise.allSettled([a.boot(), b.boot()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = a.isWriterActive ? a : b, loser = a.isWriterActive ? b : a;
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toContain('already owns');
    await expect(loser.flush()).rejects.toThrow('writer');
    const count = await new EventStore(pool!, ISLAND_GRID).total();
    expect(count).toBe(10);
    expect((await pool!.query('select count(*)::int as n from snapshots')).rows[0].n).toBe(1);
    await winner.advance(2); await winner.stop();
    await expect(winner.advance(1)).rejects.toThrow('writer');
    const replacement = new SimHost(options()); await replacement.boot();
    expect(replacement.world.now()).toBe(7200);
    expect(replacement.world.agents).toEqual(winner.world.agents);
  });

  it('a rejected contender cannot roll back a live owner or overwrite its history', async () => {
    const a = new SimHost(options()); await a.boot(); await a.advance(3);
    const count = await new EventStore(pool!, ISLAND_GRID).total();
    const before = await new SnapshotStore(pool!).loadLatest();
    await expect(new SimHost(options()).boot()).rejects.toThrow('already owns');
    await expect(migrate(pool!)).rejects.toThrow('already owns');
    expect(await new EventStore(pool!, ISLAND_GRID).total()).toBe(count);
    expect(await new SnapshotStore(pool!).loadLatest()).toEqual(before);
    await a.advance(1); expect(a.world.now()).toBe(14400);
  });

  it('fails closed after backend termination, releases ownership and restores the durable checkpoint', async () => {
    const old = new SimHost(options()); await old.boot(); await old.advance(24); await old.advance(2);
    const api = buildApi({ host: old, pool: pool! }); await api.ready();
    const gateway = new Gateway(old);
    const socket = { send: vi.fn(), close: vi.fn() };
    gateway.handle(socket);
    try {
      const { rows } = await pool!.query<{ pid: number }>(
        `select pid from pg_locks where locktype='advisory' and classid=1447112257 and objid=1
          and database=(select oid from pg_database where datname=current_database()) and granted`);
      expect(rows).toHaveLength(1);
      // Only the lock-owning backend of this isolated *_test database is terminated.
      await pool!.query('select pg_terminate_backend($1)', [rows[0]!.pid]);
      await vi.waitFor(() => expect(old.isWriterActive).toBe(false), { timeout: 3000 });
      expect((await api.inject('/health')).statusCode).toBe(503);
      const sent = socket.send.mock.calls.length;
      gateway.broadcast();
      expect(socket.close).toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledTimes(sent);
      const newcomer = { send: vi.fn(), close: vi.fn() };
      gateway.handle(newcomer);
      expect(newcomer.close).toHaveBeenCalledOnce(); expect(newcomer.send).not.toHaveBeenCalled();
      const time = old.world.now();
      const replacement = new SimHost(options());
      expect((await replacement.boot()).restoredFrom).toBe(24 * 3600);
      const count = await new EventStore(pool!, ISLAND_GRID).total();
      await expect(old.advance(1)).rejects.toThrow('writer');
      await expect(old.flush()).rejects.toThrow('writer');
      await expect(old.snapshotNow()).rejects.toThrow('writer');
      expect(old.world.now()).toBe(time);
      expect(await new EventStore(pool!, ISLAND_GRID).total()).toBe(count);
      await replacement.advance(1);
      expect(replacement.world.now()).toBe(25 * 3600);
    } finally { gateway.close(); await api.close(); }
  });

  it('cleans up ownership after HTTP startup failure, allowing a later valid server', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, resolve));
    const address = occupied.address();
    if (address === null || typeof address === 'string') throw new Error('missing test address');
    vi.stubEnv('DATABASE_URL', url!); vi.stubEnv('PORT', String(address.port));
    vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('NARRATION_DAILY_TOKENS', '0');
    vi.stubEnv('WORLD_HOURS_PER_REAL_HOUR', '12');
    try {
      await expect(startServer()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      const replacement = new SimHost(options()); await replacement.boot();
      expect(replacement.isWriterActive).toBe(true);
      await replacement.stop();
      vi.stubEnv('PORT', '0');
      const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
      const server = await startServer();
      await Promise.all([server.close(), server.close()]);
      expect(process.listenerCount('SIGINT')).toBe(sigint);
      expect(process.listenerCount('SIGTERM')).toBe(sigterm);
      const final = new SimHost(options()); await final.boot();
      expect(final.isWriterActive).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
