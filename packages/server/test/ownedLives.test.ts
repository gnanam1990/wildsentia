import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { OwnershipStore } from '../src/ownership/store.js';
import { LifeService } from '../src/ownership/lives.js';
import { loadOwnershipConfig } from '../src/ownership/purchase.js';
import { testDatabaseUrl } from './testDatabase.js';
import { ownedAsset, person } from './ownershipFixtures.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const config = loadOwnershipConfig(fileURLToPath(new URL('../../../config/ownership-congo.json', import.meta.url)));

let host: SimHost;
beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive cascade');
  host = new SimHost({ pool: pool!, seed: 7, speciesDir, terrainProfile: 'congo_v1',
    initialAgents: { african_leopard: 6, blue_duiker: 200, water_chevrotain: 20 }, minPopulation: {}, landscape: null });
  await host.boot();
}, 300_000);
afterAll(async () => { await host?.abort(); await pool?.end(); });

// Congo 1C: each life of an owned asset follows its sim animal, from spawn to death and cooldown.
maybe('owned lives', () => {
  let store: OwnershipStore, lives: LifeService;
  beforeEach(async () => {
    await pool!.query('truncate control_leases, asset_agent_grants, animal_lives, animal_assets, sim_ledger, sim_purchases, accounts, live_agents cascade');
    store = new OwnershipStore(pool!, 'world-test');
    checkpoints = 0;
    lives = new LifeService(store, host, config, async () => { checkpoints++; });
  });
  let checkpoints = 0;

  it('spawns an owned animal on safe ground, away from its hunters, up to the owner\'s limit', async () => {
    const owner = await person(pool!, 1);
    const assets = await Promise.all([1, 2, 3].map(() => ownedAsset(store, owner)));
    const first = await lives.spawn(owner.accountId, assets[0]!);
    if (!first.ok) throw new Error(first.reason);
    const animal = host.world.animal(first.animalId)!;
    expect(animal.assetId).toBe(assets[0]);
    for (const l of host.world.agents.filter((a) => a.alive && a.speciesId === 'african_leopard'))
      expect(Math.hypot(l.position!.x - animal.position!.x, l.position!.z - animal.position!.z)).toBeGreaterThan(config.spawnPredatorDistanceM);
    expect(checkpoints).toBe(1);
    expect((await store.life(first.lifeId))!.animalId).toBe(first.animalId);
    expect((await lives.spawn(owner.accountId, assets[1]!)).ok).toBe(true);
    expect(await lives.spawn(owner.accountId, assets[2]!)).toEqual({ ok: false, reason: 'alive_limit' });
    expect(await lives.spawn((await person(pool!, 2)).accountId, assets[2]!)).toEqual({ ok: false, reason: 'not_owner' });
  });

  it('ends a life once when its animal dies, with the cause, then cooldown and a fresh life', async () => {
    const owner = await person(pool!, 1), assetId = await ownedAsset(store, owner);
    const spawned = await lives.spawn(owner.accountId, assetId);
    if (!spawned.ok) throw new Error(spawned.reason);
    await store.openLease(spawned.lifeId, { kind: 'owner', id: owner.agentId });
    host.world.animal(spawned.animalId)!.drives.hunger = 1.2;
    await host.advance(1);
    const now = new Date();
    expect(await lives.reconcile(now)).toEqual([{ lifeId: spawned.lifeId, animalId: spawned.animalId, cause: 'starvation' }]);
    expect(await lives.reconcile(now)).toEqual([]);
    const ended = (await store.life(spawned.lifeId))!;
    expect(ended).toMatchObject({ status: 'cooldown', deathCause: 'starvation', killerAnimalId: null });
    expect(ended.cooldownUntil!.getTime() - ended.diedAt!.getTime()).toBe(config.cooldownMs.default);
    expect(await store.openLeaseOf(spawned.lifeId)).toBeNull();
    expect(await lives.spawn(owner.accountId, assetId)).toEqual({ ok: false, reason: 'cooldown' });
    const later = new Date(now.getTime() + config.cooldownMs.default + 1);
    const again = await lives.spawn(owner.accountId, assetId, later);
    expect(again.ok).toBe(true);
    if (again.ok) { expect(again.lifeId).not.toBe(spawned.lifeId); expect(await store.openLeaseOf(again.lifeId)).toBeNull(); }
  });

  it('ends as lost a life whose animal is missing, and frees an owned animal whose life has ended', async () => {
    const owner = await person(pool!, 1), assetId = await ownedAsset(store, owner), other = await ownedAsset(store, owner);
    const gone = await store.openLife({ assetId, ownerAccountId: owner.accountId, maxAlive: 2, now: new Date(0) });
    if (!gone.ok) throw new Error(gone.reason);
    await store.attachAnimal(gone.lifeId, 'blue_duiker_ffff', 1, 0);
    const orphan = await host.exclusive(async () => host.world.spawnOwned('blue_duiker', host.world.safeSpawnPatches('blue_duiker', 300)[0]!, other));
    expect(await lives.reconcile(new Date())).toEqual([{ lifeId: gone.lifeId, animalId: 'blue_duiker_ffff', cause: 'lost' }]);
    expect(host.world.animal(orphan.id)!.assetId).toBeUndefined();
  });
  it('ends as lost a life left alive in another world, so its asset can live again here', async () => {
    const owner = await person(pool!, 1), assetId = await ownedAsset(store, owner);
    await pool!.query("insert into animal_lives (life_id, asset_id, animal_id, world_id, status) values (gen_random_uuid(), $1, 'blue_duiker_0001', 'old-world', 'alive')", [assetId]);
    await lives.reconcile(new Date());
    expect((await store.livesOf(assetId))[0]).toMatchObject({ status: 'cooldown', deathCause: 'lost' });
  });
});
