import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { HumanMotionStore } from '../src/db/humanMotionStore.js';
import { testDatabaseUrl } from './testDatabase.js';
import { isHumanMotionPage, recordedHumanGaps, recordedHumanPose, type HumanMotionPage } from '../../client/src/humanHistoryReplay.js';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 7, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialAgents: {}, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 1000 });
afterAll(async () => { await pool?.end(); });
maybe('durable historical human movement', () => {
  beforeEach(async () => { await migrate(pool!); await pool!.query('truncate events, snapshots, tracks, animal_archive, narrations, human_motion cascade'); });

  it('records every executed hour across a delayed checkpoint and pages only that person, with restart-stable content', async () => {
    const host = new SimHost(options()); await host.boot();
    const api = buildApi({ host, pool: pool! });
    try {
      const id = host.world.community!.people[0]!.id;
      await host.advance(4);
      expect((await api.inject(`/people/${id}/motion`)).json().windows).toEqual([]);
      await host.snapshotNow();
      const firstResponse = await api.inject(`/people/${id}/motion?limit=2`);
      const first = firstResponse.json<HumanMotionPage>();
      expect(firstResponse.statusCode).toBe(200);
      expect(firstResponse.headers['cache-control']).toBe('no-store');
      expect(isHumanMotionPage(first, id)).toBe(true);
      expect(first.windows.map(w => [w.startWorldTime, w.endWorldTime])).toEqual([[10800, 14400], [7200, 10800]]);
      const second = (await api.inject(`/people/${id}/motion?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).json<HumanMotionPage>();
      expect(isHumanMotionPage(second, id)).toBe(true);
      expect(second.windows.map(w => [w.startWorldTime, w.endWorldTime])).toEqual([[3600, 7200], [0, 3600]]);
      expect(second.nextCursor).toBeNull();
      expect(recordedHumanGaps([...first.windows, ...second.windows])).toEqual([]);
      expect(recordedHumanPose(first.windows, 5400)).toBeNull();
      expect(recordedHumanPose(first.windows, 10800)?.position).toBeDefined();
      expect((await api.inject(`/people/${host.world.community!.people[1]!.id}/motion?cursor=${encodeURIComponent(first.nextCursor!)}`)).statusCode).toBe(400);
      expect((await api.inject('/people/missing/motion')).statusCode).toBe(404);
      expect((await api.inject(`/people/${id}/motion?limit=500`)).statusCode).toBe(400);
      expect((await api.inject({ method: 'POST', url: `/people/${id}/motion`, payload: { x: 1 } })).statusCode).toBe(404);
      await api.close(); await host.abort();
      const restored = new SimHost(options()); await restored.boot(); const recovered = buildApi({ host: restored, pool: pool! });
      try {
        expect((await recovered.inject(`/people/${id}/motion?cursor=${encodeURIComponent(first.nextCursor!)}`)).statusCode).toBe(400);
        const page = (await recovered.inject(`/people/${id}/motion?limit=4`)).json<HumanMotionPage>();
        expect(page.windows.map(w => w.startWorldTime)).toEqual([10800, 7200, 3600, 0]);
      } finally { await recovered.close(); }
    } finally { if (api.server.listening) await api.close(); }
  });

  it('hides pre-checkpoint rows, removes orphan recordings on recovery, and leaves an explicit legacy gap', async () => {
    const first = new SimHost(options()); await first.boot();
    const id = first.world.community!.people[0]!.id;
    await first.advance(1);
    const c = first.world.community!;
    await new HumanMotionStore(pool!).append([{ community: structuredClone(c), motion: structuredClone(c.motion!) }]);
    const api = buildApi({ host: first, pool: pool! });
    try {
      const hidden = (await api.inject(`/people/${id}/motion`)).json<HumanMotionPage>();
      expect(hidden.windows).toEqual([]);
      expect(hidden.retention).toContain('legacy');
      first.lastError = 'private diagnostics';
      expect((await api.inject(`/people/${id}/motion`)).statusCode).toBe(503);
      first.lastError = null;
    } finally { await api.close(); await first.abort(); }
    const second = new SimHost(options()); await second.boot();
    expect(Number((await pool!.query('select count(*) from human_motion')).rows[0].count)).toBe(0);
    const recovered = buildApi({ host: second, pool: pool! });
    try { expect((await recovered.inject(`/people/${id}/motion`)).json().windows).toEqual([]); }
    finally { await recovered.close(); }
  });

  it('refuses to found over durable human history when all snapshots are missing', async () => {
    const first = new SimHost(options()); await first.boot();
    await first.advance(1); await first.snapshotNow(); await first.abort();
    const before = Number((await pool!.query('select count(*) from human_motion')).rows[0].count);
    expect(before).toBeGreaterThan(0);
    await pool!.query('delete from snapshots');
    const second = new SimHost(options());
    await expect(second.boot()).rejects.toThrow(/historical human motion exists without a snapshot/);
    expect(Number((await pool!.query('select count(*) from human_motion')).rows[0].count)).toBe(before);
  });
});
