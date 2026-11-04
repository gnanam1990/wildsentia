import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { keccak256, stringToHex, type Hex } from 'viem';
import type { World } from '@vana/sim';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { ArcBountyStore } from '../src/arcBounties/store.js';
import { ArcBountyEngine, canonicalJsonOf, duration, setExternalPollMs } from '../src/arcBounties/engine.js';
import { circleSigner, idempotencyUuid } from '../src/arcBounties/circle.js';
import { constants, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, http as viemHttp } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { targetCommit, viemBountyChain, type BountyChain } from '../src/arcBounties/chain.js';
import { bountiesAbi } from '../src/challenges/bountiesAbi.js';
import Fastify from 'fastify';
import { agentArcBounties, installArcBountyRoutes, publicArcBounty } from '../src/arcBounties/routes.js';
import { testDatabaseUrl } from './testDatabase.js';
import { ANVIL_KEYS, CHAIN_ID, anvilAvailable, startLocalChain, usdcBalance, type LocalChain } from './anvil.js';

/**
 * Congo bounties paid on Arc (docs/2026-10-19-congo-arc-bounties-design.md), end to end against
 * WildsentiaBounties on a local anvil chain with the LOCAL TEST STAND-IN USDC: a prey animal picked
 * at random, the hunter's or the prey's agent paid, or the money back in the pool.
 */
const url = testDatabaseUrl();
const maybe = url && anvilAvailable() ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const HUNTER_WALLET = '0x00000000000000000000000000000000000000a1', PREY_WALLET = '0x00000000000000000000000000000000000000b2';

let host: SimHost, chain: LocalChain, bountyChain: BountyChain;
beforeAll(async () => {
  if (!url || !anvilAvailable()) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive cascade');
  host = new SimHost({ pool: pool!, seed: 7, speciesDir, terrainProfile: 'congo_v1',
    initialAgents: { african_leopard: 12, blue_duiker: 60 }, minPopulation: {}, landscape: null });
  await host.boot();
  chain = await startLocalChain();
  bountyChain = viemBountyChain({ rpcUrl: chain.url, chainId: CHAIN_ID, contract: chain.bounties, evaluatorKey: ANVIL_KEYS.evaluator });
}, 300_000);
afterAll(async () => { chain?.stop(); await host?.abort(); await pool?.end(); });

maybe('Congo bounties paid on Arc', () => {
  let store: ArcBountyStore, engine: ArcBountyEngine, ports: ConstructorParameters<typeof ArcBountyEngine>[2];
  let steered: Array<{ agentId: string; animalId: string; speciesId: string }>, wallets: Map<string, string>, notes: Array<[string, string]>;
  let networks: Map<string, string>;
  let nowShift = 0;
  let leopard: string, duiker: string;
  beforeEach(async () => {
    await pool!.query('truncate arc_bounties');
    // A leopard and a blue duiker close together, both steered by agents with proven wallets.
    const world = host.world;
    leopard = world.agents.find((a) => a.alive && a.speciesId === 'african_leopard' && a.lifeStage === 'adult')!.id;
    const at = world.animal(leopard)!.position!;
    duiker = world.agents.filter((a) => a.alive && a.speciesId === 'blue_duiker' && a.lifeStage === 'adult')
      .sort((a, b) => Math.hypot(a.position!.x - at.x, a.position!.z - at.z) - Math.hypot(b.position!.x - at.x, b.position!.z - at.z))[0]!.id;
    steered = [{ agentId: 'hunter', animalId: leopard, speciesId: 'african_leopard' }, { agentId: 'prey', animalId: duiker, speciesId: 'blue_duiker' }];
    wallets = new Map([['hunter', HUNTER_WALLET], ['prey', PREY_WALLET]]);
    networks = new Map([['hunter', 'net-a'], ['prey', 'net-b']]);
    notes = []; nowShift = 0;
    store = new ArcBountyStore(pool!, 'world-test');
    // The world, as the engine sees it, can be moved on past a deadline without stepping it.
    const shifted = new Proxy({} as World, { get: (_t, key) => key === 'now' ? () => host.world.now() + nowShift
      : (Reflect.get(host.world, key) as unknown as { bind?: unknown }) instanceof Function ? (Reflect.get(host.world, key) as (...a: unknown[]) => unknown).bind(host.world)
        : Reflect.get(host.world, key) });
    ports = {
      // The hour being played is mid-hour: a fractional world time, as live play gives.
      world: () => shifted, played: () => host.world.now() + nowShift + 0.5, rate: () => 12,
      steered: () => steered, steererOf: (id) => steered.find((s) => s.animalId === id)?.agentId ?? null,
      wallet: async (agentId) => wallets.get(agentId) ?? null, network: async (agentId) => networks.get(agentId) ?? null,
      notify: (agentId, text) => { notes.push([agentId, text]); },
      eventsOf: async () => [{ id: 'e1', worldTime: 1 }], explorer: 'https://explorer.example',
      // One steered duiker: the crowd check has its own test.
      randomCrowd: 1,
    };
    engine = new ArcBountyEngine(store, bountyChain, ports);
  }, 60_000);

  const publish = async (windowWorldSeconds = 3600) => {
    const r = await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds });
    if (!r.ok) throw new Error(r.reason);
    return r.bounty;
  };

  it('puts a bounty on the steered prey, reserves it on chain under a secret commit, and tells only its agent', async () => {
    const before = await bountyChain.pool();
    const b = await publish();
    expect(b.status).toBe('active');
    expect(b.targetAnimalId).toBe(duiker);
    expect(b.targetWallet).toBe(PREY_WALLET);
    expect(b.eligiblePredators).toContain('african_leopard');
    expect(await bountyChain.status(b.bountyId as Hex)).toBe('open');
    expect(before - (await bountyChain.pool())).toBe(5_000_000n);
    // The chain holds only the commit; the target is the keccak of the animal's id.
    expect(b.targetKey).toBe(keccak256(stringToHex(duiker)));
    expect(targetCommit(b.targetKey as Hex, b.salt as Hex)).toMatch(/^0x[0-9a-f]{64}$/);
    // Its agent is told which animal; every other steering agent hears only amount, species and region.
    expect(notes.map(([agent]) => agent)).toEqual(['prey', 'hunter']);
    expect(notes[0]![1]).toContain(duiker);
    expect(notes[0]![1]).toContain('5 USDC');
    expect(notes[0]![1]).toContain('1 hour of world time (about 5 minutes real time)');
    expect(notes[1]![1]).toContain(`5 USDC bounty is live on Arc on a blue duiker somewhere in region ${b.targetRegion}`);
    expect(notes[1]![1]).toContain('GET /agents/me/arc-bounties');
    expect(notes[1]![1]).not.toContain(duiker);
    // The same animal cannot carry two at once.
    const again = await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600 });
    expect(again).toEqual({ ok: false, reason: 'no_candidate' });
  }, 60_000);

  it('pays the hunting agent whose predator kills it, revealing the target and the record hash', async () => {
    const b = await publish();
    await engine.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
    const after = (await store.get(b.bountyId))!;
    expect(after.status).toBe('paid');
    expect(after.outcome).toBe('predator');
    expect(after.payeeWallet).toBe(HUNTER_WALLET);
    expect(after.winnerAnimalId).toBe(leopard);
    expect(await usdcBalance(chain, HUNTER_WALLET)).toBe(5_000_000n);
    expect(await bountyChain.status(b.bountyId as Hex)).toBe('paid');
    // The winner hears it is paid and where; the prey's agent that it ended.
    expect(notes.find(([agent, text]) => agent === 'hunter' && text.startsWith('Your '))?.[1]).toMatch(new RegExp(`caught ${duiker}.*it is yours\\. Paid on Arc to ${HUNTER_WALLET}`));
    expect(notes.at(-1)).toEqual(['prey', `The 5 USDC bounty on your ${duiker} has ended (a hunter caught it).`]);
    // Anyone can check the record against the hash on chain.
    expect(keccak256(stringToHex(canonicalJsonOf(after.record)))).toBe(after.recordHash);
  }, 60_000);

  it('holds a payment the contract refuses as too early (version 2), and pays it once the contract allows', async () => {
    const owner = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS.owner), transport: viemHttp(chain.url), chain: null });
    const reader = createPublicClient({ transport: viemHttp(chain.url) });
    const setMinOpen = async (seconds: bigint) => reader.waitForTransactionReceipt({
      hash: await owner.writeContract({ address: chain.bounties, abi: bountiesAbi, functionName: 'setMinOpenSeconds', args: [seconds] }) });
    await setMinOpen(600n);
    const paidBefore = await usdcBalance(chain, HUNTER_WALLET);
    try {
      const b = await publish();
      await engine.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
      const held = (await store.get(b.bountyId))!;
      expect(held.status).toBe('deciding');
      expect(held.error).toMatch(/TooEarly/);
      expect(await bountyChain.status(b.bountyId as Hex)).toBe('open');
      // The pending-decision pass sends it again once the contract would take it.
      await setMinOpen(0n);
      await engine.processPending();
      expect((await store.get(b.bountyId))!.status).toBe('paid');
      expect(await usdcBalance(chain, HUNTER_WALLET) - paidBefore).toBe(5_000_000n);
    } finally { await setMinOpen(0n); }
  }, 60_000);

  it('lets each agent read the live bounties (never which animal), the one on its own animal, and the results', async () => {
    const b = await publish();
    const deps = { store, engine, chain: bountyChain, adminToken: null, now: () => host.world.now() };
    const at = host.world.animal(leopard)!, here = { x: at.position!.x, z: at.position!.z };
    const hunter = await agentArcBounties(deps, 'hunter', { animalId: leopard, speciesId: 'african_leopard', region: engine.regionOf(at.patchId), ...here });
    expect(hunter.live).toHaveLength(1);
    expect(hunter.live[0]).toMatchObject({ bountyId: b.bountyId, speciesId: 'blue_duiker', region: b.targetRegion, amountAtomic: '5000000', youCanTake: true });
    expect(hunter.live[0]!.area).toMatchObject({ x: expect.any(Number), z: expect.any(Number), sizeM: expect.any(Number) });
    expect(JSON.stringify(hunter.live)).not.toContain(duiker);
    expect(hunter.yours).toEqual([]);
    const preyAt = host.world.animal(duiker)!;
    const prey = await agentArcBounties(deps, 'prey', { animalId: duiker, speciesId: 'blue_duiker', region: engine.regionOf(preyAt.patchId), x: 0, z: 0 });
    expect(prey.live[0]!.youCanTake).toBe(false);
    expect(prey.live[0]!.inYourRegion).toBe(true);
    expect(prey.yours).toEqual([expect.objectContaining({ bountyId: b.bountyId, targetAnimalId: duiker, payeeWallet: PREY_WALLET })]);
    // Another agent steering another duiker is not told it is the one.
    expect((await agentArcBounties(deps, 'someone', { animalId: 'blue_duiker_x', speciesId: 'blue_duiker', region: null, x: 0, z: 0 })).yours).toEqual([]);
    await engine.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
    const after = await agentArcBounties(deps, 'hunter', null);
    expect(after.live).toEqual([]);
    expect(after.results[0]).toMatchObject({ bountyId: b.bountyId, outcome: 'predator', youWon: true, targetAnimalId: duiker });
  }, 60_000);

  it('pays the prey agent that keeps it alive and in hand to the deadline', async () => {
    const b = await publish(3600);
    await engine.adjudicate();
    expect((await store.get(b.bountyId))!.status).toBe('active');
    nowShift = 3600;
    const before = await usdcBalance(chain, PREY_WALLET);
    await engine.adjudicate();
    const after = (await store.get(b.bountyId))!;
    expect(after.outcome).toBe('survived');
    expect(after.status).toBe('paid');
    expect(await usdcBalance(chain, PREY_WALLET) - before).toBe(5_000_000n);
  }, 60_000);

  it('returns the money to the pool when the prey agent let go of it, or a hunter without a wallet killed it', async () => {
    let b = await publish(3600);
    const poolBefore = await bountyChain.pool();
    steered = steered.filter((s) => s.agentId !== 'prey');
    nowShift = 3600;
    await engine.adjudicate();
    let after = (await store.get(b.bountyId))!;
    expect(after.outcome).toBe('void');
    expect(after.status).toBe('voided');
    expect(await bountyChain.pool() - poolBefore).toBe(5_000_000n);

    steered.push({ agentId: 'prey', animalId: duiker, speciesId: 'blue_duiker' });
    nowShift = 0;
    wallets.delete('hunter');
    // With requireHunter off: no hunter has a proven wallet now.
    const r = await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600, requireHunter: false });
    if (!r.ok) throw new Error(r.reason);
    b = r.bounty;
    await engine.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
    after = (await store.get(b.bountyId))!;
    expect(after.outcome).toBe('void');
    expect(after.status).toBe('voided');
  }, 60_000);

  it('never pays a hunter from the prey agent\'s own network, nor puts a bounty where only such a hunter is near', async () => {
    networks.set('hunter', 'net-b');
    expect(await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600 })).toEqual({ ok: false, reason: 'no_candidate' });
    const r = await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600, requireHunter: false });
    if (!r.ok) throw new Error(r.reason);
    await engine.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
    const after = (await store.get(r.bounty.bountyId))!;
    expect(after.outcome).toBe('void');
    expect(after.status).toBe('voided');
  }, 60_000);

  it('never pays a kill involving a person whose network is still the old shared placeholder', async () => {
    networks.set('prey', 'human');
    const r = await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600, requireHunter: false });
    if (!r.ok) throw new Error(r.reason);
    await engine.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
    expect((await store.get(r.bounty.bountyId))!.outcome).toBe('void');
  }, 60_000);

  it('puts a random bounty only on a prey hidden among three alike that could carry it too, from three networks', async () => {
    // Blue duikers in the target's region (stand-ins: this small test world has none there).
    const world = ports.world();
    const inCrowd = new Proxy(world, { get: (target, key) => key === 'animal'
      ? (id: string) => world.animal(id.startsWith('cover_') ? duiker : id) : Reflect.get(target, key) });
    engine = new ArcBountyEngine(store, bountyChain, { ...ports, world: () => inCrowd, randomCrowd: 3 });
    const tooFew = async () => expect(await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600, requireHunter: false }))
      .toEqual({ ok: false, reason: 'too_few_alike' });
    const cover = (n: number, network: string, wallet: string | null) => {
      steered.push({ agentId: `cover-${n}`, animalId: `cover_${n}`, speciesId: 'blue_duiker' });
      networks.set(`cover-${n}`, network);
      if (wallet) wallets.set(`cover-${n}`, wallet);
    };
    // Steered without a wallet: a hunter can rule it out (it could never carry a bounty), so no cover.
    cover(0, 'net-c', null);
    cover(1, 'net-d', null);
    await tooFew();
    // With wallets, but from one network: one person's agents count once.
    cover(2, 'net-c', '0x00000000000000000000000000000000000000c3');
    cover(3, 'net-c', '0x00000000000000000000000000000000000000c4');
    await tooFew();
    // A third network: a crowd of three.
    cover(4, 'net-e', '0x00000000000000000000000000000000000000c5');
    const r = await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600 });
    if (!r.ok) throw new Error(r.reason);
    // Any of the prey that could carry it, never one ruled out.
    expect([duiker, 'cover_2', 'cover_3', 'cover_4']).toContain(r.bounty.targetAnimalId);
  }, 60_000);

  it('does not pay a kill that came a fraction of a second after the deadline', async () => {
    const b = await publish(3600);
    // The played clock is at the deadline plus half a second (see `played` above).
    nowShift = b.deadlineWorldTime - host.world.now();
    await engine.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
    const after = (await store.get(b.bountyId))!;
    expect(after.killWorldTime).toBe(b.deadlineWorldTime + 1);
    expect(after.outcome).toBe('void');
  }, 60_000);

  it('finishes a decision a stop left unsent, and never pays twice', async () => {
    const b = await publish(3600);
    // Decided, but the server stopped before sending it.
    await store.decide(b.bountyId, { outcome: 'survived', payeeWallet: PREY_WALLET, winnerAgentId: 'prey', winnerAnimalId: duiker,
      decidedWorldTime: b.deadlineWorldTime, record: { test: true }, recordHash: keccak256(stringToHex('{"test":true}')) });
    const before = await usdcBalance(chain, PREY_WALLET);
    await engine.processPending();
    expect((await store.get(b.bountyId))!.status).toBe('paid');
    expect(await usdcBalance(chain, PREY_WALLET) - before).toBe(5_000_000n);
    await engine.processPending();
    expect(await usdcBalance(chain, PREY_WALLET) - before).toBe(5_000_000n);
  }, 60_000);

  it('gives the operator\'s panel every bounty with its target, behind the admin token, and the public never the live target', async () => {
    const b = await publish();
    const app = Fastify();
    installArcBountyRoutes(app, { store, engine, chain: bountyChain, adminToken: 'admin-test-token', now: () => host.world.now() });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/congo/admin/arc-bounties' })).statusCode).toBe(401);
    const view = (await app.inject({ method: 'GET', url: '/congo/admin/arc-bounties', headers: { authorization: 'Bearer admin-test-token' } })).json();
    expect(view.poolAtomic).toBe((await bountyChain.pool()).toString());
    expect(view.limits).toEqual({ minAtomic: '1000000', maxAtomic: '100000000' });
    expect(view.bounties[0]).toMatchObject({ bountyId: b.bountyId, targetAnimalId: duiker, targetAgentId: 'prey', status: 'active' });
    const pub = (await app.inject({ method: 'GET', url: `/congo/arc-bounties/${b.bountyId}` })).json();
    expect(pub.targetAnimalId).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain(duiker);
    await app.close();
  }, 60_000);

  it('drops a bounty on any animal the operator chooses: a wild one pays only a hunter, else goes back to the pool', async () => {
    // A wild blue duiker nobody steers.
    const wild = host.world.agents.find((a) => a.alive && a.speciesId === 'blue_duiker' && a.id !== duiker)!.id;
    expect(await engine.inspect(wild)).toMatchObject({ ok: true, agentId: null, wallet: null });
    const r = await engine.publishOn({ animalId: wild, amountAtomic: 2_000_000n, windowWorldSeconds: 3600 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.bounty).toMatchObject({ status: 'active', targetAnimalId: wild, targetAgentId: null, targetWallet: null });
    expect(r.bounty.rules).toMatchObject({ selection: 'operator' });
    // No agent steers it, so nobody is told which animal; the steering agents hear only that one is live.
    expect(notes.every(([, text]) => !text.includes(wild) && text.includes('bounty is live on Arc'))).toBe(true);
    expect(await engine.inspect(wild)).toEqual({ ok: false, reason: 'target_taken' });
    const poolBefore = await bountyChain.pool();
    nowShift = 3600;
    await engine.adjudicate();
    const survived = (await store.get(r.bounty.bountyId))!;
    expect(survived.outcome).toBe('void');
    expect(await bountyChain.pool() - poolBefore).toBe(2_000_000n);

    // The steered duiker, chosen by hand: its agent is told, and a hunter's kill pays the hunter.
    nowShift = 0;
    const d = await engine.publishOn({ animalId: duiker, amountAtomic: 1_000_000n, windowWorldSeconds: 3600 });
    if (!d.ok) throw new Error(d.reason);
    expect(d.bounty.targetAgentId).toBe('prey');
    expect(notes.find(([, text]) => text.includes(duiker))?.[0]).toBe('prey');
    const before = await usdcBalance(chain, HUNTER_WALLET);
    await engine.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
    expect((await store.get(d.bounty.bountyId))!.outcome).toBe('predator');
    expect(await usdcBalance(chain, HUNTER_WALLET) - before).toBe(1_000_000n);
  }, 60_000);

  it('never pays a hunter for prey its own side steered at the kill: a wild target taken later, or one held without a proven wallet', async () => {
    const wild = host.world.agents.find((a) => a.alive && a.speciesId === 'blue_duiker' && a.id !== duiker
      && !steered.some((s) => s.animalId === a.id))!.id;
    const r = await engine.publishOn({ animalId: wild, amountAtomic: 1_000_000n, windowWorldSeconds: 3600 });
    if (!r.ok) throw new Error(r.reason);
    // After publication, an agent from the hunter's own network takes the wild prey and walks it to the hunter.
    networks.set('accomplice', 'net-a');
    await engine.onHunt({ predatorId: leopard, preyId: wild, predatorAgentId: 'hunter', preyAgentId: 'accomplice', killed: true });
    let after = (await store.get(r.bounty.bountyId))!;
    expect(after.killPreyAgentId).toBe('accomplice');
    expect(after.outcome).toBe('void');

    // The hunter's own agent cannot be the prey's either, whatever its network.
    const wild2 = host.world.agents.find((a) => a.alive && a.speciesId === 'blue_duiker' && ![duiker, wild].includes(a.id)
      && !steered.some((s) => s.animalId === a.id))!.id;
    const r2 = await engine.publishOn({ animalId: wild2, amountAtomic: 1_000_000n, windowWorldSeconds: 3600 });
    if (!r2.ok) throw new Error(r2.reason);
    await engine.onHunt({ predatorId: leopard, preyId: wild2, predatorAgentId: 'hunter', preyAgentId: 'hunter', killed: true });
    after = (await store.get(r2.bounty.bountyId))!;
    expect(after.outcome).toBe('void');
  }, 60_000);

  it('shows the public what the pool took in and paid, who won this season, and a share card that never names a live target', async () => {
    const app = Fastify();
    installArcBountyRoutes(app, { store, engine, chain: bountyChain, adminToken: null, now: () => host.world.now(), fromBlock: 0n, origin: 'https://forest.example' });
    await app.ready();
    const live = await publish();
    const card = await app.inject({ method: 'GET', url: `/share/bounty/${live.bountyId}` });
    expect(card.statusCode).toBe(200);
    expect(card.body).toContain('og:title');
    expect(card.body).toContain('https://forest.example/bounties.html#' + live.bountyId);
    expect(card.body).not.toContain(duiker);
    await engine.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
    const paidCard = (await app.inject({ method: 'GET', url: `/share/bounty/${live.bountyId}` })).body;
    expect(paidCard).toContain('A hunter agent won 5 USDC');
    const stats = (await app.inject({ method: 'GET', url: '/congo/arc-bounties/stats' })).json();
    expect(stats.fundedAtomic).toBe('500000000');
    expect(stats.paidAtomic).toBe('5000000');
    expect(stats.bounties).toMatchObject({ paid: 1, live: 0 });
    const board = (await app.inject({ method: 'GET', url: '/congo/arc-bounties/leaderboard' })).json();
    expect(board.season.id).toMatch(/^\d{4}-W\d{2}$/);
    expect(board.agents).toEqual([{ agentId: 'hunter', name: null, kills: 1, escapes: 0, wonAtomic: '5000000' }]);
    expect((await app.inject({ method: 'GET', url: '/congo/arc-bounties/leaderboard?season=all' })).json().agents).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/congo/arc-bounties/leaderboard?season=nope' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/congo/arc-bounties/${live.bountyId}` })).json().watchPath).toMatch(/^\/#animal=/);
    await app.close();
  }, 60_000);

  it('never lets public requests drive the chain: one flow scan a minute, from where the last ended, and shared pool reads', async () => {
    const calls: bigint[] = []; let poolReads = 0;
    const counted: BountyChain = { ...bountyChain, flows: (from) => { calls.push(from); return bountyChain.flows(from); },
      pool: () => { poolReads++; return bountyChain.pool(); } };
    const app = Fastify();
    installArcBountyRoutes(app, { store, engine, chain: counted, adminToken: null, now: () => host.world.now(), fromBlock: 0n });
    await app.ready();
    const answers = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/congo/arc-bounties/stats' })));
    expect(answers.every((r) => r.json().fundedAtomic === '500000000')).toBe(true);
    expect(calls).toEqual([0n]);
    expect(poolReads).toBe(1);
    await app.close();
  }, 60_000);

  it('refuses to drop a bounty on a protected, unhunted, dead or unknown animal', async () => {
    expect(await engine.inspect('blue_duiker_zzzz')).toEqual({ ok: false, reason: 'not_found' });
    expect(await engine.inspect(leopard)).toEqual({ ok: false, reason: 'not_hunted' });
    expect(await engine.publishOn({ animalId: 'blue_duiker_zzzz', amountAtomic: 1_000_000n, windowWorldSeconds: 3600 })).toEqual({ ok: false, reason: 'not_found' });
  }, 60_000);

  it('tells a span as people say it', () => {
    expect(duration(1200)).toBe('20 minutes');
    expect(duration(100)).toBe('2 minutes');
    expect(duration(3600)).toBe('1 hour');
    expect(duration(5400)).toBe('1.5 hours');
    expect(duration(3 * 86_400)).toBe('3 days');
    expect(duration(86_400 + 6 * 3600)).toBe('1 day 6 hours');
  });

  it('refuses a bounty the pool cannot cover, or outside the contract limits', async () => {
    expect(await engine.publishRandom({ amountAtomic: 101_000_000n, windowWorldSeconds: 3600 })).toEqual({ ok: false, reason: 'amount_out_of_range' });
    expect(await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 60 })).toEqual({ ok: false, reason: 'bad_window' });
  }, 60_000);
  it('refuses to publish from a key that is not the contract evaluator (one rotated out, or the wrong one)', async () => {
    const other = viemBountyChain({ rpcUrl: chain.url, chainId: CHAIN_ID, contract: chain.bounties, evaluatorKey: ANVIL_KEYS.player });
    const wrong = new ArcBountyEngine(store, other, ports);
    expect(await wrong.checkIdentity()).toEqual({ ok: false, reason: 'not_the_evaluator' });
    expect(await wrong.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600 })).toEqual({ ok: false, reason: 'not_the_evaluator' });
    expect(await engine.checkIdentity()).toEqual({ ok: true });
  }, 60_000);

  it('caps what bounties may reserve in a day, however they are dropped', async () => {
    const capped = new ArcBountyEngine(store, bountyChain, { ...ports, dailyCapAtomic: 6_000_000n });
    expect((await capped.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600 })).ok).toBe(true);
    const wild = host.world.agents.find((a) => a.alive && a.speciesId === 'blue_duiker' && a.id !== duiker)!.id;
    expect(await capped.publishOn({ animalId: wild, amountAtomic: 2_000_000n, windowWorldSeconds: 3600 })).toEqual({ ok: false, reason: 'daily_cap' });
    expect((await capped.publishOn({ animalId: wild, amountAtomic: 1_000_000n, windowWorldSeconds: 3600 })).ok).toBe(true);
  }, 60_000);

  it('never pays a payee changed in the database: the payee must be the winning agent\'s proven wallet', async () => {
    const b = await publish(3600);
    await store.decide(b.bountyId, { outcome: 'predator', payeeWallet: HUNTER_WALLET, winnerAgentId: 'hunter', winnerAnimalId: leopard,
      decidedWorldTime: b.publishedWorldTime + 10, record: { test: true }, recordHash: keccak256(stringToHex('{"test":true}')) });
    await pool!.query('update arc_bounties set payee_wallet = $2 where bounty_id = $1', [b.bountyId, '0x00000000000000000000000000000000000000c3']);
    await engine.processPending();
    const after = (await store.get(b.bountyId))!;
    expect(after.status).toBe('deciding');
    expect(after.error).toContain('payee_mismatch');
    expect(await bountyChain.status(b.bountyId as Hex)).toBe('open');
    expect(await usdcBalance(chain, '0x00000000000000000000000000000000000000c3')).toBe(0n);
  }, 60_000);

  it('keeps the salt secret until the chain has settled a bounty, not while its decision is pending', async () => {
    const b = await publish(3600);
    await store.decide(b.bountyId, { outcome: 'survived', payeeWallet: PREY_WALLET, winnerAgentId: 'prey', winnerAnimalId: duiker,
      decidedWorldTime: b.deadlineWorldTime, record: { test: true }, recordHash: keccak256(stringToHex('{"test":true}')) });
    const deciding = publicArcBounty((await store.get(b.bountyId))!, host.world.now(), engine);
    expect(deciding).not.toHaveProperty('salt'); expect(deciding).not.toHaveProperty('targetKey');
    await engine.processPending();
    const paid = publicArcBounty((await store.get(b.bountyId))!, host.world.now(), engine);
    expect(paid).toMatchObject({ status: 'paid', salt: b.salt, targetKey: b.targetKey });
  }, 60_000);

  it('pays through a Circle developer-controlled wallet: a fresh ciphertext each write, one transaction per idempotency key', async () => {
    // A stand-in for Circle's API in front of anvil: it holds the evaluator key and sends for it.
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const entitySecret = randomBytes(32).toString('hex'), seen = new Set<string>(), byKey = new Map<string, string>(), txs = new Map<string, Hex>();
    const account = privateKeyToAccount(ANVIL_KEYS.evaluator);
    const wallet = createWalletClient({ account, transport: viemHttp(chain.url) }), reader = createPublicClient({ transport: viemHttp(chain.url) });
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TEST_API_KEY:id:secret');
      if (u.pathname === '/v1/w3s/config/entity/publicKey') return json(200, { publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
      if (u.pathname === '/v1/w3s/developer/transactions/contractExecution') {
        const body = JSON.parse(String(init!.body)) as { idempotencyKey: string; entitySecretCiphertext: string; contractAddress: Hex; callData: Hex; walletId: string };
        expect(body.walletId).toBe('wallet-1');
        // Circle refuses a ciphertext used twice, and one that does not open to the registered secret.
        expect(seen.has(body.entitySecretCiphertext)).toBe(false); seen.add(body.entitySecretCiphertext);
        expect(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(body.entitySecretCiphertext, 'base64')).toString('hex')).toBe(entitySecret);
        const again = byKey.get(body.idempotencyKey);
        if (again) return json(200, { id: again, state: 'INITIATED' });
        const id = `tx-${byKey.size + 1}`; byKey.set(body.idempotencyKey, id);
        txs.set(id, await wallet.sendTransaction({ chain: null, to: body.contractAddress, data: body.callData }));
        return json(201, { id, state: 'INITIATED' });
      }
      const m = /^\/v1\/w3s\/transactions\/(.+)$/.exec(u.pathname);
      if (m) {
        const hash = txs.get(m[1]!)!, r = await reader.getTransactionReceipt({ hash }).catch(() => null);
        return json(200, { transaction: { id: m[1], state: r ? (r.status === 'success' ? 'COMPLETE' : 'FAILED') : 'SENT', txHash: hash } });
      }
      return json(404, null);
    }) as typeof fetch;
    setExternalPollMs(50);
    const signer = circleSigner({ apiKey: 'TEST_API_KEY:id:secret', entitySecret, walletId: 'wallet-1', walletAddress: account.address, baseUrl: 'https://circle.test', fetch: fake });
    const circleChain = viemBountyChain({ rpcUrl: chain.url, chainId: CHAIN_ID, contract: chain.bounties, signer });
    const viaCircle = new ArcBountyEngine(store, circleChain, ports);
    expect(await viaCircle.checkIdentity()).toEqual({ ok: true });
    const r = await viaCircle.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 3600 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.bounty.status).toBe('active');
    // The chain hash, not Circle's reference, is kept for the explorer link.
    expect(r.bounty.publishTx).toMatch(/^0x[0-9a-f]{64}$/);
    const before = await usdcBalance(chain, HUNTER_WALLET);
    await viaCircle.onHunt({ predatorId: leopard, preyId: duiker, predatorAgentId: 'hunter', killed: true });
    expect((await store.get(r.bounty.bountyId))!.status).toBe('paid');
    expect(await usdcBalance(chain, HUNTER_WALLET) - before).toBe(5_000_000n);
    expect(byKey.size).toBe(2); // One publish, one settle.
    // Sent again under the same key (a crash between Circle's answer and our record): the first transaction, not a second.
    const [firstKey, firstId] = [...byKey][0]!;
    expect(await signer.send(chain.bounties, '0x', firstKey)).toBe(firstId);
    expect(byKey.size).toBe(2);
    // A call the contract would refuse is refused by name before anything reaches Circle.
    await expect(circleChain.submit!({ fn: 'expire', id: r.bounty.bountyId as Hex }, idempotencyUuid('refused'))).rejects.toThrow();
    expect(byKey.size).toBe(2);
    expect(idempotencyUuid('a')).toBe(idempotencyUuid('a'));
    expect(idempotencyUuid('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // A refused ciphertext would show as reuse: every write carried its own.
    expect(seen.size).toBe(3);
  }, 60_000);

  // Last: it moves the chain's clock past the bounty's expiry.
  it('returns an expired bounty to the pool itself, and tells nobody they were paid when the chain paid nobody', async () => {
    const b = await publish(3600);
    // Decided for the hunter, but never sent before the bounty expired (a stranded decision, or a long outage).
    await store.decide(b.bountyId, { outcome: 'predator', payeeWallet: HUNTER_WALLET, winnerAgentId: 'hunter', winnerAnimalId: leopard,
      decidedWorldTime: b.publishedWorldTime + 10, record: { test: true }, recordHash: keccak256(stringToHex('{"test":true}')) });
    await pool!.query(`update arc_bounties set expires_at = now() - interval '5 minutes', decide_sent_at = now() - interval '1 hour' where bounty_id = $1`, [b.bountyId]);
    await chain.mine(Math.ceil((b.expiresAt.getTime() - Date.now()) / 1000) + 120);
    const poolBefore = await bountyChain.pool();
    notes = [];
    await engine.processPending();
    const after = (await store.get(b.bountyId))!;
    expect(await bountyChain.status(b.bountyId as Hex)).toBe('expired');
    expect(after).toMatchObject({ status: 'voided', outcome: 'void', payeeWallet: null });
    expect(await bountyChain.pool() - poolBefore).toBe(5_000_000n);
    expect(notes.some(([, text]) => /it is yours/.test(text))).toBe(false);
  }, 60_000);
});
