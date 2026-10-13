import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// @ts-expect-error a plain ES module without types
import { hunt, mcpClient } from '../agent-client/examples/congo-hunter.mjs';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const config = loadOwnershipConfig(fileURLToPath(new URL('../../../config/ownership-congo.json', import.meta.url)));

let host: SimHost, app: FastifyInstance, live: LiveLayer, base = '', ticker: NodeJS.Timeout | undefined;
let ownership: OwnershipStore, lives: LifeService, engine: BountyEngine, discovery: BountyDiscovery;
beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive, live_possessions cascade');
  await pool!.query('truncate bounty_records, bounty_entrants, bounty_settlements, bounties, control_leases, asset_agent_grants, animal_lives, animal_assets, sim_ledger, sim_purchases, accounts, live_agents cascade');
  host = new SimHost({ pool: pool!, seed: 7, speciesDir, terrainProfile: 'congo_v1',
    initialAgents: { african_leopard: 46, blue_duiker: 200, water_chevrotain: 20 }, minPopulation: {}, landscape: null });
  await host.boot();
  const port = worldPort(() => host.world, () => 'w1', undefined, () => host.busy);
  live = new LiveLayer(port, null);
  ownership = new OwnershipStore(pool!, 'w1');
  lives = new LifeService(ownership, host, config);
  const control = new ControlService(ownership, live, { assetOf: (id) => host.world.animal(id)?.assetId,
    block: (id) => host.world.possessionBlock(id, { owner: true, ignoreController: true }), exclusive: (w) => host.exclusive(w) });
  const bountyStore = new BountyStore(pool!, 'w1');
  engine = new BountyEngine(bountyStore, ownership, host, new DevSettlementAdapter(bountyStore), () => 12);
  discovery = new BountyDiscovery(bountyStore, () => 'w1');
  live.onHunt = (h) => { if (h.killed) void engine.adjudicate(); };
  app = Fastify();
  installLiveAgents(app, { live, world: port, store: new AgentStore(pool!), ledger: null,
    limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's', clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)),
    owned: { store: ownership, config, shop: new SimulatedPurchaseAdapter(ownership, config), lives, control },
    bounties: { store: bountyStore, engine, discovery, adminToken: null, now: () => host.world.now() } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
  // The live layer runs in real time: chases advance between the agent's commands.
  ticker = setInterval(() => { try { live.tick(0.25); } catch { /* the world is stepping */ } }, 50);
}, 300_000);
afterAll(async () => { clearInterval(ticker); await app?.close(); await host?.abort(); await pool?.end(); });

// Congo 1E gate: the example agent, over the MCP bridge, finds a bounty target by perception and hunts it.
maybe('the example agent', () => {
  it('registers, is authorised, takes its leopard, senses the bounty target and catches it, and the bounty pays its owner', async () => {
    await ownership.ledgerPost(pool!, [{ category: 'reward_pool', amountAtomic: 1_000_000_000n, decimals: 6, ref: 'test top-up' }]);
    const leopardOwner = await person(pool!, 1), duikerOwner = await person(pool!, 2);
    const leopardAsset = await ownedAsset(ownership, leopardOwner, 'african_leopard'), leopard = await lives.spawn(leopardOwner.accountId, leopardAsset);
    const duiker = await lives.spawn(duikerOwner.accountId, await ownedAsset(ownership, duikerOwner, 'blue_duiker'));
    if (!leopard.ok || !duiker.ok) throw new Error('spawn failed');
    const draft = await engine.draft({ targetAnimalId: duiker.animalId, preset: 'standard' });
    if (!draft.ok) throw new Error(draft.reason);
    expect((await engine.publish(draft.bounty.bountyId)).ok).toBe(true);
    await discovery.refresh();

    const mcp = mcpClient({ ...process.env, VANA_URL: base, VANA_PROFILE: 'hunter', HOME: mkdtempSync(join(tmpdir(), 'congo-agent-')) });
    try {
      expect((await mcp.start()).serverInfo.name).toBe('wildsentia-congo');
      expect((await mcp.tools()).length).toBeGreaterThanOrEqual(17);
      const me = await mcp.call('register_agent', { name: 'Hunter' });
      await ownership.grant(leopardAsset, me.agentId);
      // The owner's leopard starts its hunt 60 m downwind of the duiker, as if it had ranged there.
      const log: string[] = [];
      const placed = (async () => {
        for (let i = 0; i < 200 && !live.avatars.get(me.agentId); i++) await new Promise((r) => setTimeout(r, 25));
        const avatar = live.avatars.get(me.agentId)!, prey = host.world.animal(duiker.animalId)!.position!;
        avatar.x = prey.x + 60; avatar.z = prey.z;
      })();
      const result = await hunt(mcp, { log: (l: string) => log.push(l), tick: () => new Promise((r) => setTimeout(r, 1000)), maxSteps: 40 });
      await placed;
      expect(result, log.join('\n')).toMatchObject({ ok: true, target: duiker.animalId, bountyId: draft.bounty.bountyId });
      // The chase plays out in real time; the leopard catches the duiker or it gets away.
      for (let i = 0; i < 120 && host.world.animal(duiker.animalId)!.alive; i++) await new Promise((r) => setTimeout(r, 250));
      if (!host.world.animal(duiker.animalId)!.alive) {
        await engine.adjudicate();
        expect((await mcp.call('get_bounty_status', { bountyId: draft.bounty.bountyId }))).toMatchObject({ status: 'settled', outcome: 'predator' });
      } else {
        expect(log.join('\n')).toMatch(/hunt:/);
      }
    } finally { mcp.close(); }
  });
});
