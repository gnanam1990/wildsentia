import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { OwnershipStore } from '../src/ownership/store.js';
import { LifeService } from '../src/ownership/lives.js';
import { ControlService } from '../src/ownership/control.js';
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

// Congo 1C: one controller at a time for an owned animal, the owner or an agent they authorised.
maybe('who steers an owned animal', () => {
  let store: OwnershipStore, live: LiveLayer, control: ControlService, lives: LifeService;
  const human = (p: { agentId: string }) => ({ id: p.agentId, kind: 'human' as const, name: 'Owner' });
  const agent = (p: { agentId: string }) => ({ id: p.agentId, kind: 'agent' as const, name: 'Bot' });
  /** The live layer, the world and the database agree on one holder (or none). */
  const holders = async (lifeId: string, animalId: string) => {
    const steering = [...live.avatars.values()].filter((a) => a.animalId === animalId).map((a) => a.agentId);
    const lease = await store.openLeaseOf(lifeId);
    expect(steering.length).toBeLessThanOrEqual(1);
    expect(host.world.animal(animalId)!.controller ?? null).toBe(steering[0] ?? null);
    expect(lease?.holderId ?? null).toBe(steering[0] ?? null);
    return steering[0] ?? null;
  };
  beforeEach(async () => {
    await pool!.query('truncate control_leases, asset_agent_grants, animal_lives, animal_assets, sim_ledger, sim_purchases, accounts, live_agents cascade');
    for (const a of [...live?.avatars.values() ?? []]) live.release(a.agentId);
    store = new OwnershipStore(pool!, 'world-test');
    live = new LiveLayer(worldPort(() => host.world, () => 'world-test', undefined, () => host.busy), null);
    lives = new LifeService(store, host, config);
    control = new ControlService(store, live, { assetOf: (id) => host.world.animal(id)?.assetId, block: (id) => host.world.possessionBlock(id, { owner: true, ignoreController: true }), exclusive: (work) => host.exclusive(work) });
    live.onEnded = (life) => { void control.ended(life); };
  });

  async function ownedLife() {
    const owner = await person(pool!, 1), assetId = await ownedAsset(store, owner);
    const spawned = await lives.spawn(owner.accountId, assetId);
    if (!spawned.ok) throw new Error(spawned.reason);
    return { owner, assetId, ...spawned };
  }

  it('refuses a stranger and an agent the owner has not authorised', async () => {
    const { animalId } = await ownedLife(), stranger = await person(pool!, 2), bot = await person(pool!, 3);
    expect(await control.take(human(stranger), animalId)).toEqual({ ok: false, reason: 'not_authorised' });
    expect(await control.take(agent(bot), animalId)).toEqual({ ok: false, reason: 'not_authorised' });
    expect(await control.take(human(stranger), 'blue_duiker_0001')).toEqual({ ok: false, reason: 'not_owned' });
  });

  it('hands control from owner to agent and back, never with two holders', async () => {
    const { owner, assetId, lifeId, animalId } = await ownedLife(), bot = await person(pool!, 3);
    expect((await control.take(human(owner), animalId)).ok).toBe(true);
    expect(await holders(lifeId, animalId)).toBe(owner.agentId);
    await store.grant(assetId, bot.agentId);
    expect((await control.take(agent(bot), animalId)).ok).toBe(true);
    expect(await holders(lifeId, animalId)).toBe(bot.agentId);
    expect((await control.take(human(owner), animalId)).ok).toBe(true);
    expect(await holders(lifeId, animalId)).toBe(owner.agentId);
    expect(await control.release(owner.agentId)).toBe(true);
    expect(await holders(lifeId, animalId)).toBeNull();
  });

  it('settles racing takes on one holder that all three agree on', async () => {
    const { owner, assetId, lifeId, animalId } = await ownedLife(), bot = await person(pool!, 3);
    await store.grant(assetId, bot.agentId);
    const results = await Promise.all([control.take(human(owner), animalId), control.take(agent(bot), animalId)]);
    expect(results.some((r) => r.ok)).toBe(true);
    expect(await holders(lifeId, animalId)).not.toBeNull();
  });

  it('releases an agent whose grant is revoked, and ends the lease when the animal\'s life ends', async () => {
    const { owner, assetId, lifeId, animalId } = await ownedLife(), bot = await person(pool!, 3);
    await store.grant(assetId, bot.agentId);
    expect((await control.take(agent(bot), animalId)).ok).toBe(true);
    expect(await control.revoke(owner.accountId, assetId, bot.agentId)).toBe(true);
    expect(await holders(lifeId, animalId)).toBeNull();
    expect((await control.take(human(owner), animalId)).ok).toBe(true);
    live.release(owner.agentId, 'gone', 'died');
    await control.idle();
    expect(await store.openLeaseOf(lifeId)).toBeNull();
  });
  it('ignores a life of the same animal id in another world, and a stale notice of an ended possession', async () => {
    const { owner, lifeId, animalId } = await ownedLife(), stranger = await person(pool!, 2), assetId = await ownedAsset(store, stranger);
    // Another world's life once held an animal with this id: it gives its owner nothing here.
    await pool!.query("insert into animal_lives (life_id, asset_id, animal_id, world_id, status) values (gen_random_uuid(), $1, 'blue_duiker_0003', 'other-world', 'alive')", [assetId]);
    expect(await control.take(human(stranger), 'blue_duiker_0003')).toEqual({ ok: false, reason: 'not_owned' });
    // A notice of a possession that ended before the current lease began never ends it.
    const before = Date.now() - 60_000;
    expect((await control.take(human(owner), animalId)).ok).toBe(true);
    await control.ended({ agentId: owner.agentId, animalId, speciesId: 'blue_duiker', since: before - 1000, endedAt: before, how: 'released' });
    expect(await holders(lifeId, animalId)).toBe(owner.agentId);
  });
  it('takes and revokes correctly while the world is stepping', async () => {
    const { owner, assetId, lifeId, animalId } = await ownedLife(), bot = await person(pool!, 3);
    await store.grant(assetId, bot.agentId);
    const [, took] = await Promise.all([host.advance(1), control.take(agent(bot), animalId)]);
    expect(took.ok).toBe(true);
    expect(await holders(lifeId, animalId)).toBe(bot.agentId);
    const [, revoked] = await Promise.all([host.advance(1), control.revoke(owner.accountId, assetId, bot.agentId)]);
    expect(revoked).toBe(true);
    expect(await holders(lifeId, animalId)).toBeNull();
  });

  it('leaves the owner in control when an agent\'s take would fail', async () => {
    const { owner, assetId, lifeId, animalId } = await ownedLife(), bot = await person(pool!, 3);
    await store.grant(assetId, bot.agentId);
    expect((await control.take(human(owner), animalId)).ok).toBe(true);
    host.world.animal(animalId)!.altitudeM = 3;
    expect(await control.take(agent(bot), animalId)).toEqual({ ok: false, reason: 'off_the_ground' });
    delete host.world.animal(animalId)!.altitudeM;
    expect(await holders(lifeId, animalId)).toBe(owner.agentId);
  });
});
