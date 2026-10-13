import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import type { OwnedDeps } from '../src/ownership/routes.js';
import { testDatabaseUrl } from './testDatabase.js';
import { person } from './ownershipFixtures.js';
import { keypair, signedHeaders } from './agentSigning.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
// A one-second cooldown, so the journey can wait it out.
const config = { ...loadOwnershipConfig(fileURLToPath(new URL('../../../config/ownership-congo.json', import.meta.url))), cooldownMs: { default: 1000 } };
const ORIGIN = 'https://wildsentia.test';

let host: SimHost, app: FastifyInstance, live: LiveLayer;
const owned = (): OwnedDeps => {
  const store = new OwnershipStore(pool!, 'w1');
  return { store, config, shop: new SimulatedPurchaseAdapter(store, config), lives: new LifeService(store, host, config),
    animalOf: (id: string) => { const a = host.world.animal(id); return a?.alive ? { state: a.state, steered: live.avatars.byAnimal(id) !== undefined } : null; },
    control: new ControlService(store, live, { assetOf: (id) => host.world.animal(id)?.assetId, block: (id) => host.world.possessionBlock(id, { owner: true, ignoreController: true }), exclusive: (work) => host.exclusive(work) }) };
};
let deps: OwnedDeps, owner: { accountId: string; agentId: string; wallet: string };

beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive, live_possessions cascade');
  await pool!.query('truncate control_leases, asset_agent_grants, animal_lives, animal_assets, sim_ledger, sim_purchases, accounts, live_agents cascade');
  host = new SimHost({ pool: pool!, seed: 7, speciesDir, terrainProfile: 'congo_v1',
    initialAgents: { african_leopard: 6, blue_duiker: 200, water_chevrotain: 20 }, minPopulation: {}, landscape: null });
  await host.boot();
  live = new LiveLayer(worldPort(() => host.world, () => 'w1', undefined, () => host.busy), null);
  deps = owned();
  live.onEnded = (life) => { void deps.control.ended(life); };
  owner = await person(pool!, 1);
  app = Fastify();
  installLiveAgents(app, { live, world: worldPort(() => host.world, () => 'w1'), store: new AgentStore(pool!), ledger: null,
    limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's', clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)),
    humans: { origin: ORIGIN, account: async (req) => (req.headers.cookie === 'ws_session=owner' ? { agentId: owner.agentId, xAccountDays: 400 } : null) },
    owned: deps });
  await app.ready();
}, 300_000);
afterAll(async () => { await app?.close(); await host?.abort(); await pool?.end(); });

const asOwner = (method: 'GET' | 'POST', path: string, body?: object) => app.inject({ method, url: path,
  headers: { cookie: 'ws_session=owner', origin: ORIGIN, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
  ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
const bot = keypair();
const asAgent = (path: string, body: object) => {
  const payload = JSON.stringify(body);
  return app.inject({ method: 'POST', url: path, headers: signedHeaders(bot, 'vana:w1', 'POST', path, payload), payload });
};

// Congo 1C gate: owning, steering, dying and respawning work end to end, by a person and by an agent.
maybe('the Congo ownership journey', () => {
  it('buys, spawns, steers, hands over, dies, waits out the cooldown and lives again', async () => {
    const store = (await asOwner('GET', '/congo/store')).json();
    expect(store).toMatchObject({ simulated: true, maxAlivePerOwner: 2 });
    const bought = (await asOwner('POST', '/congo/store/buy', { speciesId: 'african_leopard', idempotencyKey: randomUUID() })).json();
    expect(bought).toMatchObject({ simulated: true, speciesId: 'african_leopard', priceAtomic: '50000000' });
    const first = (await asOwner('POST', `/congo/assets/${bought.assetId}/spawn`)).json();
    expect(first.animalId).toMatch(/^african_leopard_/);

    // The owner steers it; only owned animals can be taken, and only by name.
    expect((await asOwner('POST', '/play/possess', { animalId: first.animalId })).json()).toMatchObject({ animalId: first.animalId, controller: 'owner' });
    const registered = (await asAgent('/agents/register', { name: 'Tracker', bio: 'Follows the river' })).json();
    expect((await asAgent('/agents/me/possess', { speciesId: 'african_leopard' })).json()).toEqual({ error: 'owned_only' });
    expect((await asAgent('/agents/me/possess', { animalId: first.animalId })).json()).toEqual({ error: 'not_authorised' });

    // The owner authorises the agent, which takes over: the owner no longer steers it.
    expect((await asOwner('POST', `/congo/assets/${bought.assetId}/agents`, { agentId: registered.agentId })).json()).toEqual({ granted: true });
    expect((await asAgent('/agents/me/possess', { animalId: first.animalId })).json()).toMatchObject({ controller: 'agent' });
    expect(live.avatars.has(owner.agentId)).toBe(false);
    expect(host.world.animal(first.animalId)!.controller).toBe(registered.agentId);
    let mine = (await asOwner('GET', '/congo/assets')).json().assets[0];
    expect(mine.life.controller).toEqual({ kind: 'agent', id: registered.agentId });
    expect(mine.animal).toEqual({ state: expect.any(String), steered: true });

    // It dies (starved in the hourly step): the agent loses it, the life ends with its cause.
    host.world.animal(first.animalId)!.drives.hunger = 1.2;
    await host.advance(1);
    live.tick(0.1);
    await deps.control.idle();
    await deps.lives.reconcile();
    mine = (await asOwner('GET', '/congo/assets')).json().assets[0];
    expect(mine.life).toMatchObject({ animalId: first.animalId, status: 'cooldown', deathCause: 'starvation', controller: null });
    expect(live.avatars.has(registered.agentId)).toBe(false);

    // A restart: a fresh service sees the same cooldown in the database.
    deps = owned();
    expect((await asOwner('POST', `/congo/assets/${bought.assetId}/spawn`)).json()).toEqual({ error: 'cooldown' });
    await new Promise((r) => setTimeout(r, 1100));
    const second = (await asOwner('POST', `/congo/assets/${bought.assetId}/spawn`)).json();
    expect(second.animalId).not.toBe(first.animalId);
    expect((await asOwner('POST', '/play/possess', { animalId: second.animalId })).json()).toMatchObject({ controller: 'owner' });
    expect(await deps.store.livesOf(bought.assetId)).toHaveLength(2);
    expect((await asOwner('POST', '/play/release')).json()).toEqual({ ok: true });
    expect(await deps.store.openLeaseOf(second.lifeId)).toBeNull();
  });
});
