import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { keccak256, stringToHex, type Hex } from 'viem';
import type { World } from '@vana/sim';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { ArcBountyStore } from '../src/arcBounties/store.js';
import { ArcBountyEngine, canonicalJsonOf } from '../src/arcBounties/engine.js';
import { targetCommit, viemBountyChain, type BountyChain } from '../src/arcBounties/chain.js';
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
  let store: ArcBountyStore, engine: ArcBountyEngine;
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
    engine = new ArcBountyEngine(store, bountyChain, {
      // The hour being played is mid-hour: a fractional world time, as live play gives.
      world: () => shifted, played: () => host.world.now() + nowShift + 0.5, rate: () => 12,
      steered: () => steered, steererOf: (id) => steered.find((s) => s.animalId === id)?.agentId ?? null,
      wallet: async (agentId) => wallets.get(agentId) ?? null, network: async (agentId) => networks.get(agentId) ?? null,
      notify: (agentId, text) => { notes.push([agentId, text]); },
      eventsOf: async () => [{ id: 'e1', worldTime: 1 }], explorer: 'https://explorer.example',
    });
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
    expect(notes).toHaveLength(1);
    expect(notes[0]![0]).toBe('prey');
    expect(notes[0]![1]).toContain('5 USDC');
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
    // Anyone can check the record against the hash on chain.
    expect(keccak256(stringToHex(canonicalJsonOf(after.record)))).toBe(after.recordHash);
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

  it('refuses a bounty the pool cannot cover, or outside the contract limits', async () => {
    expect(await engine.publishRandom({ amountAtomic: 101_000_000n, windowWorldSeconds: 3600 })).toEqual({ ok: false, reason: 'amount_out_of_range' });
    expect(await engine.publishRandom({ amountAtomic: 5_000_000n, windowWorldSeconds: 60 })).toEqual({ ok: false, reason: 'bad_window' });
  }, 60_000);
});
