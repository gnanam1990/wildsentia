import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { AgentStore } from '../src/live/liveStore.js';
import { installLiveAgents } from '../src/live/routes.js';
import { OwnershipStore } from '../src/ownership/store.js';
import { LifeService } from '../src/ownership/lives.js';
import { ControlService } from '../src/ownership/control.js';
import { SimulatedPurchaseAdapter, loadOwnershipConfig } from '../src/ownership/purchase.js';
import { BountyStore } from '../src/bounties/store.js';
import { BountyEngine, DevSettlementAdapter } from '../src/bounties/engine.js';
import { BountyDiscovery } from '../src/bounties/discovery.js';
import { testDatabaseUrl } from './testDatabase.js';
import { ownedAsset, person } from './ownershipFixtures.js';
import { keypair, signedHeaders } from './agentSigning.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const config = loadOwnershipConfig(fileURLToPath(new URL('../../../config/ownership-congo.json', import.meta.url)));

let host: SimHost, app: FastifyInstance, live: LiveLayer, ownership: OwnershipStore, lives: LifeService, engine: BountyEngine, discovery: BountyDiscovery;
beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive, live_possessions cascade');
  await pool!.query('truncate bounty_records, bounty_entrants, bounty_settlements, bounties, control_leases, asset_agent_grants, animal_lives, animal_assets, sim_ledger, sim_purchases, accounts, live_agents cascade');
  host = new SimHost({ pool: pool!, seed: 7, speciesDir, terrainProfile: 'congo_v1',
    initialAgents: { african_leopard: 46, blue_duiker: 200, water_chevrotain: 20 }, minPopulation: {}, landscape: null });
  await host.boot();
  live = new LiveLayer(worldPort(() => host.world, () => 'w1', undefined, () => host.busy), null);
  ownership = new OwnershipStore(pool!, 'w1');
  lives = new LifeService(ownership, host, config);
  const control = new ControlService(ownership, live, { assetOf: (id) => host.world.animal(id)?.assetId,
    block: (id) => host.world.possessionBlock(id, { owner: true, ignoreController: true }), exclusive: (w) => host.exclusive(w) });
  const bountyStore = new BountyStore(pool!, 'w1');
  engine = new BountyEngine(bountyStore, ownership, host, new DevSettlementAdapter(bountyStore), () => 12);
  discovery = new BountyDiscovery(bountyStore, () => 'w1');
  app = Fastify();
  installLiveAgents(app, { live, world: worldPort(() => host.world, () => 'w1'), store: new AgentStore(pool!), ledger: null,
    limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's', clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)),
    owned: { store: ownership, config, shop: new SimulatedPurchaseAdapter(ownership, config), lives, control },
    bounties: { store: bountyStore, engine, discovery, adminToken: null, now: () => host.world.now() } });
  await app.ready();
}, 300_000);
afterAll(async () => { await app?.close(); await host?.abort(); await pool?.end(); });

const keys = { bot: keypair(), stranger: keypair() };
const asAgent = (who: keyof typeof keys, method: 'GET' | 'POST', path: string, body?: object) => {
  const payload = body ? JSON.stringify(body) : '';
  return app.inject({ method, url: path, headers: signedHeaders(keys[who], 'vana:w1', method, path, payload), ...(body ? { payload } : {}) });
};

// Congo 1E (spec §7): the agent's tools over the signed transport, scoped to what its owners authorised.
maybe('agent tools', () => {
  it('lists the animals an agent may steer, their lives, a pace change, its bounties and a bounty\'s status', async () => {
    await ownership.ledgerPost(pool!, [{ category: 'reward_pool', amountAtomic: 1_000_000_000n, decimals: 6, ref: 'test top-up' }]);
    const owner = await person(pool!, 1), other = await person(pool!, 2);
    const bot = (await asAgent('bot', 'POST', '/agents/register', { name: 'Hunter' })).json();
    await asAgent('stranger', 'POST', '/agents/register', { name: 'Stranger' });
    const leopardAsset = await ownedAsset(ownership, owner, 'african_leopard'), leopard = await lives.spawn(owner.accountId, leopardAsset);
    const duiker = await lives.spawn(other.accountId, await ownedAsset(ownership, other, 'blue_duiker'));
    if (!leopard.ok || !duiker.ok) throw new Error('spawn failed');
    await ownership.grant(leopardAsset, bot.agentId);

    const mine = (await asAgent('bot', 'GET', '/agents/me/animals')).json();
    expect(mine.animals).toEqual([expect.objectContaining({ assetId: leopardAsset, speciesId: 'african_leopard',
      life: expect.objectContaining({ animalId: leopard.animalId, status: 'alive', controller: null }), animal: expect.objectContaining({ state: expect.any(String) }) })]);
    expect((await asAgent('stranger', 'GET', '/agents/me/animals')).json().animals).toEqual([]);
    expect((await asAgent('bot', 'GET', `/agents/me/animals/${leopardAsset}/lives`)).json().lives).toEqual([expect.objectContaining({ animalId: leopard.animalId, status: 'alive' })]);
    expect((await asAgent('stranger', 'GET', `/agents/me/animals/${leopardAsset}/lives`)).statusCode).toBe(404);

    expect((await asAgent('bot', 'POST', '/agents/me/gait', { gait: 'run' })).json()).toEqual({ error: 'not_possessing' });
    await asAgent('bot', 'POST', '/agents/me/possess', { animalId: leopard.animalId });
    expect((await asAgent('bot', 'POST', '/agents/me/gait', { gait: 'trot' })).json()).toEqual({ ok: true, gait: 'trot' });
    expect((await asAgent('bot', 'POST', '/agents/me/gait', { gait: 'fly' })).statusCode).toBe(400);
    expect(live.avatars.get(bot.agentId)!.gait).toBe('trot');

    const d = await engine.draft({ targetAnimalId: duiker.animalId, preset: 'standard' });
    if (!d.ok) throw new Error(d.reason);
    expect((await engine.publish(d.bounty.bountyId)).ok).toBe(true);
    await discovery.refresh();
    const prey = host.world.animal(duiker.animalId)!.position!, avatar = live.avatars.get(bot.agentId)!;
    avatar.x = prey.x + 15; avatar.z = prey.z;
    const board = (await asAgent('bot', 'GET', '/agents/me/bounties')).json();
    expect(board).toMatchObject({ simulated: true, bounties: [expect.objectContaining({ bountyId: d.bounty.bountyId, speciesId: 'blue_duiker' })],
      sensed: [expect.objectContaining({ bountyId: d.bounty.bountyId, animalId: duiker.animalId })] });
    // The stranger, possessing nothing, sees the public board only.
    expect((await asAgent('stranger', 'GET', '/agents/me/bounties')).json()).toMatchObject({ sensed: [], lastSeen: [] });
    expect((await app.inject({ method: 'GET', url: `/congo/bounties/${d.bounty.bountyId}` })).json()).toMatchObject({ status: 'active', speciesId: 'blue_duiker' });
    expect(JSON.stringify((await app.inject({ method: 'GET', url: `/congo/bounties/${d.bounty.bountyId}` })).json())).not.toContain(duiker.animalId);
  });
});
