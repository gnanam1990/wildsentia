import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { OwnershipStore } from '../src/ownership/store.js';
import { SimulatedPurchaseAdapter, loadOwnershipConfig, splitFee } from '../src/ownership/purchase.js';
import { testDatabaseUrl } from './testDatabase.js';
import { person } from './ownershipFixtures.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });
const config = loadOwnershipConfig(fileURLToPath(new URL('../../../config/ownership-congo.json', import.meta.url)));

describe('the simulated store\'s arithmetic (Congo 1C)', () => {
  it('splits a fee in exact integers, the odd unit to the unallocated half', () => {
    expect(splitFee(5_000_000n, 500)).toEqual({ fee: 250_000n, pool: 125_000n, unallocated: 125_000n, proceeds: 4_750_000n });
    expect(splitFee(101n, 500)).toEqual({ fee: 5n, pool: 2n, unallocated: 3n, proceeds: 96n });
    expect(config.maxAlivePerOwner).toBe(2);
    expect(config.cooldownMs.default).toBe(7_200_000);
  });
});

maybe('the simulated store (Congo 1C)', () => {
  let store: OwnershipStore, shop: SimulatedPurchaseAdapter;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate control_leases, asset_agent_grants, animal_lives, animal_assets, sim_ledger, sim_purchases, accounts, live_agents cascade');
    store = new OwnershipStore(pool!, 'world-test'); shop = new SimulatedPurchaseAdapter(store, config);
  });

  it('quotes in exact integer units, labelled SIMULATED', async () => {
    expect(shop.quote('african_leopard')).toEqual({ speciesId: 'african_leopard', priceAtomic: '50000000', feeAtomic: '2500000', decimals: 6,
      token: 'SIM-USDC', pricingVersion: 'sim-2026-10-13', simulated: true });
    expect(shop.quote('tiger')).toBeNull();
  });

  it('buys once per key: an asset, the fee split to the pool and unallocated, the rest to proceeds', async () => {
    const owner = await person(pool!, 1), key = randomUUID();
    const first = await shop.buy({ accountId: owner.accountId, wallet: owner.wallet }, 'blue_duiker', key);
    const again = await shop.buy({ accountId: owner.accountId, wallet: owner.wallet }, 'blue_duiker', key);
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.asset.assetId).toBe(first.asset.assetId);
    expect(again.replayed).toBe(true);
    expect(first.simulated).toBe(true);
    const ledger = (await pool!.query('select category, amount_atomic::text as a from sim_ledger order by entry_id')).rows;
    expect(ledger).toEqual([{ category: 'reward_pool', a: '125000' }, { category: 'unallocated', a: '125000' }, { category: 'proceeds', a: '4750000' }]);
    expect(await store.poolBalance()).toBe(125_000n);
  });

  it('refuses an owner without a proven wallet, an unknown species and a short key', async () => {
    const owner = await person(pool!, 1);
    expect(await shop.buy({ accountId: owner.accountId, wallet: null }, 'blue_duiker', randomUUID())).toEqual({ ok: false, reason: 'no_wallet' });
    expect(await shop.buy({ accountId: owner.accountId, wallet: owner.wallet }, 'tiger', randomUUID())).toEqual({ ok: false, reason: 'unknown_species' });
    expect(await shop.buy({ accountId: owner.accountId, wallet: owner.wallet }, 'blue_duiker', 'short')).toEqual({ ok: false, reason: 'bad_key' });
  });

  it('sells back a resting asset: retired, its fee owed to burn; never one that is alive', async () => {
    const owner = await person(pool!, 1), o = { accountId: owner.accountId, wallet: owner.wallet };
    const bought = await shop.buy(o, 'blue_duiker', randomUUID());
    if (!bought.ok) throw new Error('buy failed');
    const life = await store.openLife({ assetId: bought.asset.assetId, ownerAccountId: owner.accountId, maxAlive: 2, now: new Date() });
    expect(await shop.sell(o, bought.asset.assetId, randomUUID())).toEqual({ ok: false, reason: 'alive' });
    if (life.ok) await store.endLife(life.lifeId, { cause: 'starvation', killerAnimalId: null, worldTime: 1, cooldownMs: 0, now: new Date() });
    const sold = await shop.sell(o, bought.asset.assetId, randomUUID());
    expect(sold).toMatchObject({ ok: true, simulated: true });
    expect((await store.asset(bought.asset.assetId))!.status).toBe('retired');
    const burn = (await pool!.query("select amount_atomic::text as a from sim_ledger where category='burn_obligation'")).rows;
    expect(burn).toEqual([{ a: '250000' }]);
    expect(await shop.sell(o, bought.asset.assetId, randomUUID())).toEqual({ ok: false, reason: 'not_active' });
  });
});
