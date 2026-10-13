import { readFileSync } from 'node:fs';
import type { Asset, OwnershipStore, Purchase } from './store.js';

/**
 * Congo 1C (spec §4): every purchase goes through a `PurchaseAdapter`. Phase 1 ships only the
 * simulated one: it quotes and records in integer units of a simulated token and moves no money.
 * Real token, fee and burn adapters are Phase 2, enabled only with the owner's approval.
 */

export interface OwnershipConfig {
  maxAlivePerOwner: number;
  /** Real milliseconds a dead animal's asset waits before it may live again: per species, else the default. */
  cooldownMs: { default: number } & Record<string, number>;
  spawnPredatorDistanceM: number;
  token: string;
  decimals: number;
  pricingVersion: string;
  /** Integer units (strings: never floats). */
  prices: Record<string, string>;
  buyFeeBps: number;
  sellFeeBps: number;
}

export function loadOwnershipConfig(path: string): OwnershipConfig {
  const c = JSON.parse(readFileSync(path, 'utf8')) as OwnershipConfig;
  const integer = (v: unknown) => typeof v === 'string' && /^[0-9]{1,30}$/.test(v);
  if (!Number.isInteger(c.maxAlivePerOwner) || c.maxAlivePerOwner < 1 || !Number.isInteger(c.cooldownMs?.default) || c.cooldownMs.default < 0
    || !Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 18 || !c.pricingVersion || !c.token
    || !Object.values(c.prices ?? {}).every(integer) || ![c.buyFeeBps, c.sellFeeBps].every((b) => Number.isInteger(b) && b >= 0 && b <= 10_000))
    throw new Error(`invalid ownership config: ${path}`);
  return c;
}

/** A fee in basis points of a price, split half to the reward pool; an odd unit stays unallocated. */
export function splitFee(price: bigint, bps: number): { fee: bigint; pool: bigint; unallocated: bigint; proceeds: bigint } {
  const fee = price * BigInt(bps) / 10_000n, pool = fee / 2n;
  return { fee, pool, unallocated: fee - pool, proceeds: price - fee };
}

export interface Quote { speciesId: string; priceAtomic: string; feeAtomic: string; decimals: number; token: string; pricingVersion: string; simulated: true }
export interface Owner { accountId: string; wallet: string | null }
export type BuyResult = { ok: true; asset: Asset; purchase: Purchase; replayed: boolean; simulated: true }
  | { ok: false; reason: 'no_wallet' | 'unknown_species' | 'bad_key' };
export type SellResult = { ok: true; purchase: Purchase; simulated: true }
  | { ok: false; reason: 'no_wallet' | 'bad_key' | 'not_owner' | 'not_active' | 'alive' | 'unknown_species' };

export interface PurchaseAdapter {
  quote(speciesId: string): Quote | null;
  buy(owner: Owner, speciesId: string, idempotencyKey: string): Promise<BuyResult>;
  sell(owner: Owner, assetId: string, idempotencyKey: string): Promise<SellResult>;
}

const WALLET = /^0x[0-9a-f]{40}$/;
const KEY = /^[A-Za-z0-9_-]{8,80}$/;

export class SimulatedPurchaseAdapter implements PurchaseAdapter {
  constructor(private readonly store: OwnershipStore, readonly config: OwnershipConfig) {}

  /** The species' price, only if the config itself names it (never an inherited key). */
  #price(speciesId: string): string | undefined {
    return Object.hasOwn(this.config.prices, speciesId) ? this.config.prices[speciesId] : undefined;
  }

  quote(speciesId: string): Quote | null {
    const price = this.#price(speciesId);
    if (price === undefined) return null;
    return { speciesId, priceAtomic: price, feeAtomic: splitFee(BigInt(price), this.config.buyFeeBps).fee.toString(), decimals: this.config.decimals,
      token: this.config.token, pricingVersion: this.config.pricingVersion, simulated: true };
  }

  /** Records a SIMULATED buy and its new asset, once per key: a repeat returns the first. */
  async buy(owner: Owner, speciesId: string, idempotencyKey: string): Promise<BuyResult> {
    if (!owner.wallet || !WALLET.test(owner.wallet)) return { ok: false, reason: 'no_wallet' };
    if (!KEY.test(idempotencyKey)) return { ok: false, reason: 'bad_key' };
    const price = this.#price(speciesId);
    if (price === undefined) return { ok: false, reason: 'unknown_species' };
    const split = splitFee(BigInt(price), this.config.buyFeeBps), decimals = this.config.decimals, wallet = owner.wallet;
    return this.store.tx(async (db) => {
      const purchase = await this.store.recordPurchase({ idempotencyKey, ownerAccountId: owner.accountId, ownerWallet: wallet, kind: 'buy', speciesId,
        priceAtomic: BigInt(price), feeAtomic: split.fee, decimals, pricingVersion: this.config.pricingVersion }, [
        { category: 'reward_pool', amountAtomic: split.pool, decimals, ref: 'buy_fee' },
        { category: 'unallocated', amountAtomic: split.unallocated, decimals, ref: 'buy_fee' },
        { category: 'proceeds', amountAtomic: split.proceeds, decimals, ref: 'buy' },
      ], db);
      if (purchase.kind !== 'buy') return { ok: false, reason: 'bad_key' } as const;
      const asset = await this.store.createAsset({ ownerAccountId: owner.accountId, ownerWallet: wallet, speciesId: purchase.speciesId,
        purchaseId: purchase.purchaseId, pricingVersion: purchase.pricingVersion }, db);
      return { ok: true, asset, purchase, replayed: purchase.replayed, simulated: true } as const;
    });
  }

  /**
   * Sells an asset back to the simulated store: retired, the price less the sell fee paid out of
   * proceeds, the fee owed to burn. Refused while it is alive or controlled.
   */
  async sell(owner: Owner, assetId: string, idempotencyKey: string): Promise<SellResult> {
    if (!owner.wallet || !WALLET.test(owner.wallet)) return { ok: false, reason: 'no_wallet' };
    if (!KEY.test(idempotencyKey)) return { ok: false, reason: 'bad_key' };
    const wallet = owner.wallet;
    return this.store.tx(async (db) => {
      const asset = (await db.query('select * from animal_assets where asset_id=$1 for update', [assetId])).rows[0];
      if (!asset || asset.owner_account_id !== owner.accountId) return { ok: false, reason: 'not_owner' } as const;
      const replay = (await db.query('select * from sim_purchases where owner_account_id=$1 and idempotency_key=$2', [owner.accountId, idempotencyKey])).rows[0];
      // A key already used is honoured only for this same sale; any other use of it is refused.
      if (replay && (replay.kind !== 'sell' || replay.asset_id !== assetId)) return { ok: false, reason: 'bad_key' } as const;
      if (asset.status !== 'active' && !replay) return { ok: false, reason: 'not_active' } as const;
      if ((await db.query("select 1 from animal_lives where asset_id=$1 and status='alive'", [assetId])).rows.length) return { ok: false, reason: 'alive' } as const;
      const listed = this.#price(asset.species_id);
      if (listed === undefined) return { ok: false, reason: 'unknown_species' } as const;
      const price = BigInt(listed), split = splitFee(price, this.config.sellFeeBps), decimals = this.config.decimals;
      const purchase = await this.store.recordPurchase({ idempotencyKey, ownerAccountId: owner.accountId, ownerWallet: wallet, kind: 'sell',
        speciesId: asset.species_id, priceAtomic: price, feeAtomic: split.fee, decimals, pricingVersion: this.config.pricingVersion, assetId }, [
        { category: 'proceeds', amountAtomic: -split.proceeds, decimals, ref: `sell:${assetId}` },
        { category: 'burn_obligation', amountAtomic: split.fee, decimals, ref: `sell:${assetId}` },
      ], db);
      if (!purchase.replayed) await this.store.setAssetStatus(assetId, 'retired', db);
      return { ok: true, purchase, simulated: true } as const;
    });
  }
}
