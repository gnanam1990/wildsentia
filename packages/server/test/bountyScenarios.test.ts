import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { OwnershipStore } from '../src/ownership/store.js';
import { LifeService } from '../src/ownership/lives.js';
import { SimulatedPurchaseAdapter, loadOwnershipConfig } from '../src/ownership/purchase.js';
import { BountyStore } from '../src/bounties/store.js';
import { BountyEngine, DevSettlementAdapter } from '../src/bounties/engine.js';
import { testDatabaseUrl } from './testDatabase.js';
import { ownedAsset, person } from './ownershipFixtures.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const config = { ...loadOwnershipConfig(fileURLToPath(new URL('../../../config/ownership-congo.json', import.meta.url))), cooldownMs: { default: 0 } };

let host: SimHost;
beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive cascade');
  host = new SimHost({ pool: pool!, seed: 7, speciesDir, terrainProfile: 'congo_v1',
    initialAgents: { african_leopard: 46, blue_duiker: 200, water_chevrotain: 20 }, minPopulation: {}, landscape: null });
  await host.boot();
}, 300_000);
afterAll(async () => { await host?.abort(); await pool?.end(); });

// Congo 1D: the bounty scenarios of spec §8, one each.
maybe('bounty scenarios', () => {
  let ownership: OwnershipStore, lives: LifeService, bounties: BountyStore, engine: BountyEngine;
  let n = 0;
  let played: (() => number) | undefined;
  const fresh = () => { bounties = new BountyStore(pool!, 'world-test'); engine = new BountyEngine(bounties, ownership, host, new DevSettlementAdapter(bounties), () => 12, undefined, () => (played ?? (() => host.world.now()))()); };
  beforeEach(async () => {
    await pool!.query('truncate bounty_records, bounty_entrants, bounty_settlements, bounties, control_leases, asset_agent_grants, animal_lives, animal_assets, sim_ledger, sim_purchases, accounts, live_agents cascade');
    ownership = new OwnershipStore(pool!, 'world-test');
    lives = new LifeService(ownership, host, config);
    played = undefined;
    fresh();
  });
  const fund = (amount = 1_000_000_000n) => ownership.ledgerPost(pool!, [{ category: 'reward_pool', amountAtomic: amount, decimals: 6, ref: 'test top-up' }]);
  const owned = async (owner: { accountId: string; wallet: string }, speciesId: string) => {
    const assetId = await ownedAsset(ownership, owner, speciesId), s = await lives.spawn(owner.accountId, assetId);
    if (!s.ok) throw new Error(s.reason);
    return { assetId, ...s };
  };
  const published = async (animalId: string, windowWorldSeconds?: number) => {
    const d = await engine.draft({ targetAnimalId: animalId, preset: 'standard', ...(windowWorldSeconds ? { windowWorldSeconds } : {}) });
    if (!d.ok) throw new Error(d.reason);
    const p = await engine.publish(d.bounty.bountyId);
    if (!p.ok) throw new Error(p.reason);
    return p.bounty;
  };
  /** The killer catches the target where it stands, at world time `at` (default now). */
  const kill = (killerId: string, preyId: string, at = host.world.now()) => host.exclusive(async () => {
    const prey = host.world.animal(preyId)!;
    return host.world.resolveLiveHunt(killerId, preyId, { ...prey.position! }, at, true);
  });
  const ledger = async () => (await pool!.query('select category, amount_atomic::text as a, ref from sim_ledger order by entry_id')).rows;
  const people = async () => { n += 10; return [await person(pool!, n + 1), await person(pool!, n + 2)] as const; };

  it('pays the owner of an eligible owned predator that makes the kill, and settles once', async () => {
    await fund();
    const [prey, hunter] = await people();
    const duiker = await owned(prey, 'blue_duiker'), leopard = await owned(hunter, 'african_leopard');
    const b = await published(duiker.animalId);
    expect((await ownership.asset(duiker.assetId))!.status).toBe('locked');
    expect(await kill(leopard.animalId, duiker.animalId)).not.toBeNull();
    expect(await engine.adjudicate()).toEqual([{ bountyId: b.bountyId, outcome: 'predator', payeeWallet: hunter.wallet }]);
    expect(await bounties.get(b.bountyId)).toMatchObject({ status: 'settled', outcome: 'predator', winnerAnimalId: leopard.animalId });
    expect((await ledger()).filter((r) => r.category === 'payout')).toEqual([{ category: 'payout', a: '10000000', ref: `bounty:${b.bountyId}:payout:${hunter.wallet}` }]);
    expect((await ownership.asset(duiker.assetId))!.status).toBe('active');
    expect((await bounties.record(b.bountyId))!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pays the target\'s owner at publication when it is alive at the deadline', async () => {
    await fund();
    const [prey] = await people();
    const duiker = await owned(prey, 'blue_duiker');
    const b = await published(duiker.animalId, 3600);
    expect(await engine.adjudicate()).toEqual([]);
    await host.advance(1);
    expect(await engine.adjudicate()).toEqual([{ bountyId: b.bountyId, outcome: 'survived', payeeWallet: prey.wallet }]);
  });

  it('takes nothing more after settlement: no second payout, no cancellation', async () => {
    await fund();
    const [prey] = await people();
    const b = await published((await owned(prey, 'blue_duiker')).animalId, 3600);
    await host.advance(1);
    await engine.adjudicate();
    const before = await ledger();
    expect(await engine.adjudicate()).toEqual([]);
    expect(await engine.settlePending()).toBe(0);
    expect(await new DevSettlementAdapter(bounties).settle(b.bountyId)).toBe('already');
    expect(await bounties.decide(b.bountyId, { outcome: 'void', payeeWallet: null, winnerAnimalId: null, worldTime: 0 })).toBe(false);
    expect(await bounties.cancel(b.bountyId, 'late')).toBe(false);
    expect(await ledger()).toEqual(before);
  });

  it('orders a kill and the deadline in the same step by world time: a kill at the deadline wins, after it survival does', async () => {
    await fund();
    const [prey, hunter] = await people();
    const duiker = await owned(prey, 'blue_duiker'), leopard = await owned(hunter, 'african_leopard');
    const b = await published(duiker.animalId, 3600);
    await host.advance(1);
    await kill(leopard.animalId, duiker.animalId, b.deadlineWorldTime!);
    expect((await engine.adjudicate())[0]).toMatchObject({ outcome: 'predator', payeeWallet: hunter.wallet });
    const other = await owned(prey, 'blue_duiker'), late = await published(other.animalId, 3600);
    await host.advance(2);
    await kill(leopard.animalId, other.animalId, late.deadlineWorldTime! + 1800);
    expect((await engine.adjudicate())[0]).toMatchObject({ outcome: 'survived', payeeWallet: prey.wallet });
  });

  it('returns the reservation when the target dies of another cause', async () => {
    await fund(10_000_000n);
    const [prey] = await people();
    const duiker = await owned(prey, 'blue_duiker'), b = await published(duiker.animalId);
    expect(await ownership.poolBalance()).toBe(0n);
    host.world.animal(duiker.animalId)!.drives.hunger = 1.2;
    await host.advance(1);
    expect(await engine.adjudicate()).toEqual([{ bountyId: b.bountyId, outcome: 'void', payeeWallet: null }]);
    expect(await ownership.poolBalance()).toBe(10_000_000n);
    expect((await bounties.get(b.bountyId))!.status).toBe('settled');
  });

  it('answers duplicate commands and callbacks once', async () => {
    await fund();
    const [prey, hunter] = await people();
    const duiker = await owned(prey, 'blue_duiker'), leopard = await owned(hunter, 'african_leopard');
    const b = await published(duiker.animalId);
    expect((await engine.publish(b.bountyId)).ok).toBe(false);
    await kill(leopard.animalId, duiker.animalId);
    const [one, two] = await Promise.all([engine.adjudicate(), engine.adjudicate()]);
    expect([...one, ...two]).toHaveLength(1);
    expect((await ledger()).filter((r) => r.category === 'payout')).toHaveLength(1);
  });

  it('survives a restart between the decision and the payout, paying exactly once', async () => {
    await fund();
    const [prey] = await people();
    const b = await published((await owned(prey, 'blue_duiker')).animalId, 3600);
    await host.advance(1);
    // The decision is written (with its settlement intent), then the server stops before recording it.
    expect(await bounties.decide(b.bountyId, { outcome: 'survived', payeeWallet: prey.wallet, winnerAnimalId: null, worldTime: host.world.now() })).toBe(true);
    fresh();
    expect(await engine.settlePending()).toBe(1);
    fresh();
    expect(await engine.settlePending()).toBe(0);
    expect((await ledger()).filter((r) => r.category === 'payout')).toHaveLength(1);
  });

  it('refuses to publish an unfunded bounty', async () => {
    const [prey] = await people();
    const d = await engine.draft({ targetAnimalId: (await owned(prey, 'blue_duiker')).animalId, preset: 'elite' });
    if (!d.ok) throw new Error(d.reason);
    expect(await engine.publish(d.bounty.bountyId)).toEqual({ ok: false, reason: 'unfunded' });
    expect((await ledger()).some((r) => String(r.ref).includes(':reserve'))).toBe(false);
    expect((await bounties.get(d.bounty.bountyId))).toMatchObject({ status: 'draft', validation: { funded: false } });
  });

  it('never carries a bounty to the next life, and locks the asset while it lasts', async () => {
    await fund();
    const [prey] = await people();
    const duiker = await owned(prey, 'blue_duiker'), b = await published(duiker.animalId);
    expect(await new SimulatedPurchaseAdapter(ownership, config).sell({ accountId: prey.accountId, wallet: prey.wallet }, duiker.assetId, randomUUID()))
      .toEqual({ ok: false, reason: 'not_active' }); // locked while the bounty lasts
    host.world.animal(duiker.animalId)!.drives.hunger = 1.2;
    await host.advance(1);
    await lives.reconcile();
    await engine.adjudicate();
    const next = await lives.spawn(prey.accountId, duiker.assetId);
    if (!next.ok) throw new Error(next.reason);
    expect(await bounties.activeOnLife(next.lifeId)).toBeNull();
    expect((await bounties.get(b.bountyId))!.targetLifeId).toBe(duiker.lifeId);
  });

  it('never pays a predator owned by the target\'s own owner', async () => {
    await fund();
    const [prey] = await people();
    const duiker = await owned(prey, 'blue_duiker'), leopard = await owned(prey, 'african_leopard');
    const b = await published(duiker.animalId);
    await kill(leopard.animalId, duiker.animalId);
    expect(await engine.adjudicate()).toEqual([{ bountyId: b.bountyId, outcome: 'void', payeeWallet: null }]);
  });

  it('holds for review a bounty whose real time far outran its world-time window', async () => {
    await fund();
    const [prey] = await people();
    const b = await published((await owned(prey, 'blue_duiker')).animalId, 3600);
    await host.advance(1);
    // 3600 world seconds at 12 world hours per real hour is five real minutes; an hour later is an outage.
    expect(await engine.adjudicate(new Date(Date.now() + 3_600_000))).toEqual([{ bountyId: b.bountyId, outcome: 'on_hold', payeeWallet: null }]);
    expect((await bounties.get(b.bountyId))!.status).toBe('on_hold');
  });
  it('pays survival after an admin resumes a held bounty', async () => {
    await fund();
    const [prey] = await people();
    const b = await published((await owned(prey, 'blue_duiker')).animalId, 3600);
    await host.advance(1);
    const late = new Date(Date.now() + 3_600_000);
    expect((await engine.adjudicate(late))[0]!.outcome).toBe('on_hold');
    expect(await bounties.resume(b.bountyId)).toBe(true);
    expect(await engine.adjudicate(late)).toEqual([{ bountyId: b.bountyId, outcome: 'survived', payeeWallet: prey.wallet }]);
  });

  it('decides survival only once the hour being played has passed the deadline', async () => {
    await fund();
    const [prey] = await people();
    const b = await published((await owned(prey, 'blue_duiker')).animalId, 3600);
    await host.advance(1);
    // The world has stepped past the deadline, but viewers and live hunters are still in the hour before it.
    played = () => b.deadlineWorldTime! - 600;
    expect(await engine.adjudicate()).toEqual([]);
    played = () => b.deadlineWorldTime!;
    expect((await engine.adjudicate())[0]).toMatchObject({ outcome: 'survived' });
  });

  it('voids a bounty left active by an earlier world, returning its reservation and unlocking the asset', async () => {
    await fund(10_000_000n);
    const [prey] = await people();
    const duiker = await owned(prey, 'blue_duiker');
    const old = new BountyStore(pool!, 'old-world');
    const oldEngine = new BountyEngine(old, ownership, host, new DevSettlementAdapter(old), () => 12);
    const d = await oldEngine.draft({ targetAnimalId: duiker.animalId, preset: 'standard' });
    if (!d.ok) throw new Error(d.reason);
    expect((await oldEngine.publish(d.bounty.bountyId)).ok).toBe(true);
    expect(await ownership.poolBalance()).toBe(0n);
    expect(await engine.adjudicate()).toEqual([{ bountyId: d.bounty.bountyId, outcome: 'void', payeeWallet: null }]);
    expect(await ownership.poolBalance()).toBe(10_000_000n);
    expect((await ownership.asset(duiker.assetId))!.status).toBe('active');
  });
});
