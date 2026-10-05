import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { takeSnapshot, SIM_VERSION, ISLAND_POPULATION } from '@vana/sim';
import { islandHeightAt, positionInPatch } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { SimHost } from './trackedHost.js';
import { Gateway } from '../src/gateway.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { SceneUpdates, type SceneEnvironment } from '../../client/src/sceneUpdates.js';
import { makeHeightSampler } from '../../client/src/terrain.js';
import { asLegacySnapshot } from '../../sim/test/legacySnapshot.js';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, initialAgents: { chital: 3 }, snapshotEveryWorldHours: 12 });
afterAll(async () => { await pool?.end(); });
maybe('durable island world', () => {
  beforeEach(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
  });
  it('boots the complete founding cohort through the first ten hours and persists consistent six-hour life tracks', async () => {
    const config = { ...options(), initialAgents: ISLAND_POPULATION, snapshotEveryWorldHours: 1 };
    const host = new SimHost(config); await host.boot();
    await expect(host.advance(10)).resolves.toBeUndefined();
    const rows = await pool!.query('select patch_id, position_x, position_z, heading from tracks where world_time = 21600');
    // Nearly the whole founding cohort (1,382 at sim_0.33.0) is still alive and tracked at hour six.
    const founded = Object.values(ISLAND_POPULATION).reduce((n, c) => n + c, 0);
    expect(rows.rowCount).toBeGreaterThan(founded * 0.95);
    expect(rows.rows.every(r => positionInPatch({ x: r.position_x, z: r.position_z, heading: r.heading }, r.patch_id))).toBe(true);
    const saved = takeSnapshot(host.world); await host.abort();
    const resumed = new SimHost(config); await resumed.boot(); expect(takeSnapshot(resumed.world)).toEqual(saved);
  });
  it('requires explicit v0.15 rules upgrade and preserves a valid island checkpoint', async () => {
    const host = new SimHost(options()); await host.boot();
    const old = asLegacySnapshot(takeSnapshot(host.world), 'sim_0.15.0'); await host.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(options()).boot()).rejects.toThrow('refusing to boot');
    const upgraded = new SimHost({ ...options(), allowV15Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.agents).toEqual(old.agents);
    expect(upgraded.world.patches.some(p => p.floweringGuild)).toBe(true);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
  });
  it('uses closed defaults and preserves the same coast through database, API, gateway and client decoder', async () => {
    const host = new SimHost(options()); await host.boot();
    expect(host.worldOptions.minPopulation).toEqual({}); expect(host.worldOptions.landscape).toBeUndefined();
    const api = buildApi({ host, pool: pool! }); await api.ready(); const gateway = new Gateway(host);
    try {
      const response = await api.inject('/patches'); expect(response.statusCode).toBe(200);
      const original = response.json(); expect(original.patches.every((p: { islandSeed: number }) => p.islandSeed === 1)).toBe(true);
      const guildPatches = original.patches.filter((p: { floweringGuild: unknown }) => p.floweringGuild !== null);
      expect(guildPatches.length).toBeGreaterThan(0);
      expect(guildPatches.every((p: { floweringGuild: { guildId: string; stage: string; seedKg: number } }) =>
        p.floweringGuild.guildId === 'insect_visited_understorey_v1'
        && p.floweringGuild.stage === 'vegetative' && p.floweringGuild.seedKg === 0)).toBe(true);
      const sent: unknown[] = []; gateway.handle({ send: data => sent.push(JSON.parse(data)), close() {} });
      let prepared: SceneEnvironment | undefined;
      const updates = new SceneUpdates({ prepare: async (environment) => { prepared = environment; }, commit: vi.fn(), discard: vi.fn(), status: vi.fn() });
      expect(updates.receive(sent[0], 0)).toBe(true); expect(prepared!.patches).toEqual(original.patches.map(({ soilNutrients: _, ...p }: Record<string, unknown>) => p));
      const sample = makeHeightSampler(prepared!.patches); expect(sample(2850, 2850)).toBe(islandHeightAt(1, 2850, 2850));
      await host.advance(2); const unsaved = takeSnapshot(host.world);
      expect((await api.inject('/patches')).json()).toEqual(original);
      await host.abort();
      // Wrong selection fails before any original checkpoint is rewritten.
      await expect(new SimHost({ ...options(), terrainProfile: 'mainland' }).boot()).rejects.toThrow('terrain profile mismatch');
      const resumed = new SimHost(options()); await resumed.boot(); await resumed.advance(2);
      expect(takeSnapshot(resumed.world)).toEqual(unsaved); await resumed.snapshotNow();
      const saved = (await new SnapshotStore(pool!).loadLatest())!;
      expect(saved.terrainProfile).toBe('island_v1'); expect(saved.patches).toEqual(resumed.world.patches);
    } finally { gateway.close(); await api.close(); }
  });
  it('explicitly upgrades v0.14 mainland without changing its topology', async () => {
    const host = new SimHost({ ...options(), terrainProfile: 'mainland', minPopulation: {}, landscape: null }); await host.boot();
    const old = asLegacySnapshot(takeSnapshot(host.world), 'sim_0.14.0'); delete old.terrainProfile;
    await host.abort(); await new SnapshotStore(pool!).save(old);
    const config = { ...options(), terrainProfile: 'mainland' as const, minPopulation: {}, landscape: null };
    await expect(new SimHost(config).boot()).rejects.toThrow('refusing to boot');
    const upgraded = new SimHost({ ...config, allowV14Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.terrainProfile).toBe('mainland');
    expect(upgraded.world.patches.some(p => p.floweringGuild)).toBe(true);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
  });
});
