import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { buildApi } from '../src/api.js';
import { Gateway, type GatewaySocket } from '../src/gateway.js';
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
const TOKEN = 'admin-test-token-0123456789';

class FakeSocket implements GatewaySocket {
  raw: string[] = []; bufferedAmount = 0;
  send(data: string | Buffer): void { this.raw.push(String(data)); }
  close(): void {}
}

let host: SimHost, app: FastifyInstance, api: FastifyInstance, live: LiveLayer, bountyStore: BountyStore, engine: BountyEngine, discovery: BountyDiscovery;
let ownership: OwnershipStore, lives: LifeService;
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
  bountyStore = new BountyStore(pool!, 'w1');
  engine = new BountyEngine(bountyStore, ownership, host, new DevSettlementAdapter(bountyStore), () => 12);
  discovery = new BountyDiscovery(bountyStore, () => 'w1');
  app = Fastify();
  installLiveAgents(app, { live, world: worldPort(() => host.world, () => 'w1'), store: new AgentStore(pool!), ledger: null,
    limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's', clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)),
    owned: { store: ownership, config, shop: new SimulatedPurchaseAdapter(ownership, config), lives, control },
    bounties: { store: bountyStore, engine, discovery, adminToken: TOKEN, now: () => host.world.now() } });
  await app.ready();
  api = buildApi({ host, pool: pool! });
  await api.ready();
}, 300_000);
afterAll(async () => { await app?.close(); await api?.close(); await host?.abort(); await pool?.end(); });

const asAdmin = (method: 'GET' | 'POST', path: string, body?: object, token = TOKEN) => app.inject({ method, url: path,
  headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
const keys = { tracker: keypair(), other: keypair() };
const asAgent = (who: keyof typeof keys, method: 'GET' | 'POST', path: string, body?: object) => {
  const payload = body ? JSON.stringify(body) : '';
  return app.inject({ method, url: path, headers: signedHeaders(keys[who], 'vana:w1', method, path, payload), ...(body ? { payload } : {}) });
};

// Congo 1D: the admin editor, hidden targets, discovery by perception, and the settled record.
maybe('bounties over the API', () => {
  it('publishes through the admin editor, hides the target everywhere public, flags it only to an animal that senses it, and records the outcome', async () => {
    await ownership.ledgerPost(pool!, [{ category: 'reward_pool', amountAtomic: 1_000_000_000n, decimals: 6, ref: 'test top-up' }]);
    const preyOwner = await person(pool!, 1), hunterOwner = await person(pool!, 2);
    const duiker = await lives.spawn(preyOwner.accountId, await ownedAsset(ownership, preyOwner, 'blue_duiker'));
    const leopardAsset = await ownedAsset(ownership, hunterOwner, 'african_leopard'), leopard = await lives.spawn(hunterOwner.accountId, leopardAsset);
    if (!duiker.ok || !leopard.ok) throw new Error('spawn failed');

    // The admin editor: presets with their exact numbers, a draft, validation, publication.
    expect((await asAdmin('GET', '/congo/admin/bounties', undefined, 'wrong')).statusCode).toBe(401);
    expect((await asAdmin('GET', '/congo/admin/bounties/presets')).json().presets[0]).toMatchObject({ id: 'standard', amountAtomic: '10000000' });
    const draft = (await asAdmin('POST', '/congo/admin/bounties', { targetAnimalId: duiker.animalId, preset: 'standard' })).json();
    expect(draft, JSON.stringify(draft)).toMatchObject({ status: 'draft' });
    expect((await asAdmin('POST', `/congo/admin/bounties/${draft.bountyId}/validate`)).json()).toMatchObject({ ok: true });
    const published = (await asAdmin('POST', `/congo/admin/bounties/${draft.bountyId}/publish`)).json();
    expect(published).toMatchObject({ status: 'active', rulesHash: expect.stringMatching(/^[0-9a-f]{64}$/) });

    // The public routes serve the last checkpoint: take one that holds the owned animals (as a spawn does in the server).
    await host.snapshotNow();
    // Public: species, region, amount and time left; never the animal, its life or its owner.
    const list = (await app.inject({ method: 'GET', url: '/congo/bounties' })).json();
    expect(list.bounties).toEqual([expect.objectContaining({ bountyId: draft.bountyId, speciesId: 'blue_duiker', amountAtomic: '10000000' })]);
    const secrets = [duiker.animalId, duiker.lifeId, preyOwner.wallet];
    expect(secrets.some((s) => JSON.stringify(list).includes(s))).toBe(false);
    // Every other public route may name the animal (it is public), but never as a bounty, nor its life.
    const region = (await api.inject({ method: 'GET', url: `/regions/${published.region}` })).body;
    const bodies = [
      (await api.inject({ method: 'GET', url: '/animals' })).body, (await api.inject({ method: 'GET', url: `/animals/${duiker.animalId}` })).body,
      (await api.inject({ method: 'GET', url: '/events?limit=100' })).body, (await api.inject({ method: 'GET', url: '/world' })).body, region,
      (await app.inject({ method: 'GET', url: '/congo/store' })).body, (await app.inject({ method: 'GET', url: '/agents/info' })).body,
    ];
    const gateway = new Gateway(host), socket = new FakeSocket();
    gateway.handle(socket); gateway.disconnect(socket);
    bodies.push(...socket.raw);
    // Nothing public says which animals are owned (that would narrow a bounty's target without sensing it).
    for (const body of bodies) {
      expect(body.includes('assetId')).toBe(false);
      expect(body.includes('ownedDeath')).toBe(false);
      expect(body.includes('"owned"')).toBe(false);
    }
    for (const body of bodies) {
      expect(body.includes(draft.bountyId)).toBe(false);
      expect(body.includes(duiker.lifeId)).toBe(false);
      expect(/bounty/i.test(body)).toBe(false);
    }

    // Discovery: the tracker's leopard, 20 m from the duiker, senses it and learns of the bounty; another agent far off does not.
    const tracker = (await asAgent('tracker', 'POST', '/agents/register', { name: 'Tracker' })).json();
    await ownership.grant(leopardAsset, tracker.agentId);
    expect((await asAgent('tracker', 'POST', '/agents/me/possess', { animalId: leopard.animalId })).statusCode).toBe(200);
    const prey = host.world.animal(duiker.animalId)!.position!, avatar = live.avatars.get(tracker.agentId)!;
    avatar.x = prey.x + 20; avatar.z = prey.z;
    await discovery.refresh();
    const seen = (await asAgent('tracker', 'GET', '/agents/me/observe')).json();
    expect(seen.nearby.find((a: { id: string }) => a.id === duiker.animalId)).toMatchObject({ sense: expect.any(String), bounty: { bountyId: draft.bountyId, amountAtomic: '10000000' } });
    expect(seen.nearby.every((a: { sense?: string }) => typeof a.sense === 'string')).toBe(true);
    await discovery.idle();
    expect(await bountyStore.entrants(draft.bountyId)).toEqual([expect.objectContaining({ agentId: tracker.agentId })]);

    // The target's path while the bounty ran (its track log), for the replay.
    await bountyStore.saveTrack({ bountyId: draft.bountyId, x: prey.x, z: prey.z, state: 'grazing', worldTime: host.world.now() });
    // The kill, the outcome and its public record.
    await host.exclusive(async () => host.world.resolveLiveHunt(leopard.animalId, duiker.animalId, { ...prey }, host.world.now(), true));
    expect(await engine.adjudicate()).toEqual([{ bountyId: draft.bountyId, outcome: 'predator', payeeWallet: hunterOwner.wallet }]);
    const record = (await app.inject({ method: 'GET', url: `/congo/bounties/${draft.bountyId}/record` })).json();
    expect(record).toMatchObject({ simulated: true, outcome: 'predator', winnerAnimalId: leopard.animalId,
      payout: { wallet: hunterOwner.wallet, amountAtomic: '10000000', status: 'recorded' }, entrants: 1 });
    expect(record.record.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Once settled, the forest viewer can replay it: the target, its species and its path.
    expect(record).toMatchObject({ targetAnimalId: duiker.animalId, targetSpeciesId: 'blue_duiker' });
    expect(record.record.track).toEqual([expect.objectContaining({ state: 'grazing' })]);
  });
});
