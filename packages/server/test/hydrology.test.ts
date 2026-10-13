import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drainageGraph, newWaterBudget, takeSnapshot, SIM_VERSION } from '@vana/sim';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { EventStore } from '../src/db/eventStore.js';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { asLegacySnapshot } from '../../sim/test/legacySnapshot.js';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: {}, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 12 });
afterAll(async () => { await pool?.end(); });
maybe('durable surface hydrology', () => {
  beforeEach(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
  });
  it('publishes budget and drainage together only at a checkpoint, and abort/replay does not duplicate inflow', async () => {
    const host = new SimHost(options()); await host.boot();
    const graph = drainageGraph(host.world.grid, host.world.patches), source = host.world.patches.find(p => graph.get(p.id) !== null)!;
    source.waterVolume = 100_000; host.world.waterBudget = newWaterBudget(host.world.patches, 0);
    await host.snapshotNow();
    const api = buildApi({ host, pool: pool! }); await api.ready();
    try {
      const response = await api.inject('/hydrology');
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      const original = response.json();
      await host.advance(1);
      expect((await api.inject('/hydrology')).json()).toEqual(original);
      expect((await api.inject('/patches')).json().patches.every((p: { drainage?: unknown }) => p.drainage === undefined)).toBe(true);
      const unsaved = takeSnapshot(host.world); await host.abort();
      expect((await api.inject('/hydrology')).statusCode).toBe(503);
      const resumed = new SimHost(options()); await resumed.boot();
      expect(resumed.world.waterBudget).toEqual(original.budget);
      await resumed.advance(1); expect(takeSnapshot(resumed.world)).toEqual(unsaved);
      await resumed.snapshotNow();
      const next = buildApi({ host: resumed, pool: pool! }); await next.ready();
      try {
        const hydrology = (await next.inject('/hydrology')).json(), patches = (await next.inject('/patches')).json();
        expect(hydrology.worldTime).toBe(patches.worldTime); expect(hydrology.worldTime).toBe(3600);
        expect(hydrology.budget).toEqual(resumed.world.waterBudget); expect(Math.abs(hydrology.residualL)).toBeLessThan(1e-6);
        expect(patches.patches.find((p: { id: number }) => p.id === source.id).drainage.outflowL).toBeGreaterThan(0);
        expect((await new SnapshotStore(pool!).loadLatest())!.waterBudget).toEqual(hydrology.budget);
      } finally { await next.close(); }
    } finally { await api.close(); }
  });
  it('refuses silent v0.13 upgrade and saves an explicit accounting baseline once', async () => {
    const host = new SimHost(options()); await host.boot();
    const legacy = asLegacySnapshot(takeSnapshot(host.world), 'sim_0.13.0');
    delete legacy.waterBudget; await host.abort();
    await new SnapshotStore(pool!).save(legacy);
    await expect(new SimHost(options()).boot()).rejects.toThrow('refusing to boot');
    const upgraded = new SimHost({ ...options(), allowV13Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.waterBudget).toEqual(newWaterBudget(legacy.patches, legacy.worldTime));
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    await upgraded.abort(); const resumed = new SimHost(options()); await resumed.boot();
    expect(resumed.world.waterBudget).toEqual(upgraded.world.waterBudget);
    expect((await new EventStore(pool!, ISLAND_GRID).recent(100)).filter(e => e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
  });
});
