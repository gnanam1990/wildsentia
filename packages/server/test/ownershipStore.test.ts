import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { OwnershipStore } from '../src/ownership/store.js';
import { testDatabaseUrl } from './testDatabase.js';
import { ownedAsset, person } from './ownershipFixtures.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

maybe('OwnershipStore (Congo 1C)', () => {
  let store: OwnershipStore;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate control_leases, asset_agent_grants, animal_lives, animal_assets, sim_ledger, sim_purchases, accounts, live_agents cascade');
    store = new OwnershipStore(pool!, 'world-test');
  });

  it('lets an owner have at most the limit alive, even when their spawns race', async () => {
    const owner = await person(pool!, 1);
    const assets = await Promise.all([1, 2, 3].map(() => ownedAsset(store, owner)));
    const results = await Promise.all(assets.map((assetId) => store.openLife({ assetId, ownerAccountId: owner.accountId, maxAlive: 2, now: new Date() })));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'alive_limit' });
    // A second life of an asset that is already alive is refused.
    const live = results.find((r) => r.ok)! as { ok: true; lifeId: string };
    const again = await store.openLife({ assetId: (await store.life(live.lifeId))!.assetId, ownerAccountId: owner.accountId, maxAlive: 5, now: new Date() });
    expect(again).toEqual({ ok: false, reason: 'already_alive' });
  });

  it('refuses a life of someone else\'s asset, or one still in its cooldown, and allows it after', async () => {
    const owner = await person(pool!, 1), other = await person(pool!, 2), assetId = await ownedAsset(store, owner);
    expect(await store.openLife({ assetId, ownerAccountId: other.accountId, maxAlive: 2, now: new Date() })).toEqual({ ok: false, reason: 'not_owner' });
    const life = await store.openLife({ assetId, ownerAccountId: owner.accountId, maxAlive: 2, now: new Date() }) as { ok: true; lifeId: string };
    await store.attachAnimal(life.lifeId, 'blue_duiker_00a1', 12_880, 3600);
    const died = new Date('2026-10-13T10:00:00Z');
    expect(await store.endLife(life.lifeId, { cause: 'predation', killerAnimalId: 'african_leopard_0003', worldTime: 7200, cooldownMs: 7_200_000, now: died })).toBe(true);
    expect(await store.endLife(life.lifeId, { cause: 'predation', killerAnimalId: null, worldTime: 7300, cooldownMs: 7_200_000, now: died })).toBe(false);
    expect(await store.openLife({ assetId, ownerAccountId: owner.accountId, maxAlive: 2, now: new Date(died.getTime() + 3_600_000) })).toEqual({ ok: false, reason: 'cooldown' });
    expect((await store.openLife({ assetId, ownerAccountId: owner.accountId, maxAlive: 2, now: new Date(died.getTime() + 7_200_001) })).ok).toBe(true);
    expect(await store.settleCooldowns(new Date(died.getTime() + 7_200_001))).toBe(1);
    expect((await store.life(life.lifeId))!.status).toBe('dead');
  });

  it('keeps one open lease per life when takes race, each ending the one before', async () => {
    const owner = await person(pool!, 1), assetId = await ownedAsset(store, owner);
    const life = await store.openLife({ assetId, ownerAccountId: owner.accountId, maxAlive: 2, now: new Date() }) as { ok: true; lifeId: string };
    const takes = await Promise.all([0, 1, 2, 3, 4].map((i) => store.openLease(life.lifeId, { kind: i === 0 ? 'owner' : 'agent', id: `holder-${i}` })));
    expect(takes.every((t) => t.ok)).toBe(true);
    const open = (await pool!.query('select holder_id from control_leases where life_id=$1 and ended_at is null', [life.lifeId])).rows;
    expect(open).toHaveLength(1);
    expect((await pool!.query("select count(*)::int as n from control_leases where life_id=$1 and end_reason='handover'", [life.lifeId])).rows[0].n).toBe(4);
    expect((await store.openLeaseOf(life.lifeId))!.holderId).toBe(open[0].holder_id);
    // Death ends the lease.
    await store.endLife(life.lifeId, { cause: 'starvation', killerAnimalId: null, worldTime: 9000, cooldownMs: 1000, now: new Date() });
    expect(await store.openLeaseOf(life.lifeId)).toBeNull();
  });

  it('dates a lease by the server\'s own clock, so an end notice is judged against the same clock, whatever the database\'s', async () => {
    const owner = await person(pool!, 1), assetId = await ownedAsset(store, owner);
    const life = await store.openLife({ assetId, ownerAccountId: owner.accountId, maxAlive: 2, now: new Date() }) as { ok: true; lifeId: string };
    // A minute behind the database's clock, as if the two machines' clocks disagreed.
    const took = new Date(Date.now() - 60_000);
    const opened = await store.openLease(life.lifeId, { kind: 'owner', id: owner.agentId }, took);
    expect(opened.ok && opened.lease.startedAt.getTime()).toBe(took.getTime());
    // A notice of a possession that ended before this lease began is stale: the lease stays open.
    expect(await store.endLeaseOf(life.lifeId, owner.agentId, 'died', new Date(took.getTime() - 5))).toBe(false);
    // One that ended after it began closes it, though the database's clock is a minute later.
    expect(await store.endLeaseOf(life.lifeId, owner.agentId, 'died', new Date(took.getTime() + 5))).toBe(true);
    expect(await store.openLeaseOf(life.lifeId)).toBeNull();
  });

  it('writes only SIMULATED money, and keeps grants one per agent until revoked', async () => {
    const owner = await person(pool!, 1), agent = await person(pool!, 3), assetId = await ownedAsset(store, owner);
    await expect(pool!.query("insert into sim_ledger (category, amount_atomic, decimals, simulated) values ('reward_pool', 1, 6, false)")).rejects.toThrow();
    await store.ledgerPost(pool!, [{ category: 'reward_pool', amountAtomic: 125n, decimals: 6, ref: 'x' }]);
    expect(await store.poolBalance()).toBe(125n);
    expect(await store.grant(assetId, agent.agentId)).toBe(true);
    expect(await store.grant(assetId, agent.agentId)).toBe(false);
    expect(await store.granted(assetId, agent.agentId)).toBe(true);
    expect(await store.revoke(assetId, agent.agentId)).toBe(true);
    expect(await store.granted(assetId, agent.agentId)).toBe(false);
  });
});
