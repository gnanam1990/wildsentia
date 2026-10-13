import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Database, Pool } from '../db/pool.js';

/**
 * Congo 1C: PostgreSQL for owned animals (spec §3-§4). Assets are permanent; each life is one
 * sim animal; one control lease at a time per life; the simulated store's purchases and ledger.
 * The database is the arbiter: the one-alive-life and one-open-lease indexes hold under any race.
 */

export type AssetStatus = 'active' | 'locked' | 'retired';
export interface Asset {
  assetId: string; ownerAccountId: string; ownerWallet: string; speciesId: string; variantId: string;
  purchaseId: string; pricingVersion: string; status: AssetStatus; createdAt: Date;
}
export type LifeStatus = 'alive' | 'cooldown' | 'dead';
export interface Life {
  lifeId: string; assetId: string; animalId: string | null; worldId: string; status: LifeStatus;
  spawnPatchId: number | null; spawnedAt: Date; spawnedWorldTime: number | null;
  deathCause: string | null; killerAnimalId: string | null; diedAt: Date | null; diedWorldTime: number | null;
  cooldownUntil: Date | null; bountyId: string | null;
}
export type HolderKind = 'owner' | 'agent';
export interface Lease { leaseId: string; lifeId: string; holderKind: HolderKind; holderId: string; startedAt: Date }
export type LedgerCategory = 'reward_pool' | 'unallocated' | 'proceeds' | 'burn_obligation' | 'payout';
export interface LedgerRow { category: LedgerCategory; amountAtomic: bigint; decimals: number; ref?: string }
export interface PurchaseInput {
  idempotencyKey: string; ownerAccountId: string; ownerWallet: string; kind: 'buy' | 'sell'; speciesId: string;
  priceAtomic: bigint; feeAtomic: bigint; decimals: number; pricingVersion: string;
}
export interface Purchase extends PurchaseInput { purchaseId: string; createdAt: Date }

const asset = (r: Record<string, unknown>): Asset => ({ assetId: r.asset_id as string, ownerAccountId: r.owner_account_id as string,
  ownerWallet: r.owner_wallet as string, speciesId: r.species_id as string, variantId: r.variant_id as string,
  purchaseId: r.purchase_id as string, pricingVersion: r.pricing_version as string, status: r.status as AssetStatus, createdAt: r.created_at as Date });
const num = (v: unknown): number | null => v === null || v === undefined ? null : Number(v);
const life = (r: Record<string, unknown>): Life => ({ lifeId: r.life_id as string, assetId: r.asset_id as string, animalId: r.animal_id as string | null,
  worldId: r.world_id as string, status: r.status as LifeStatus, spawnPatchId: num(r.spawn_patch_id), spawnedAt: r.spawned_at as Date,
  spawnedWorldTime: num(r.spawned_world_time), deathCause: r.death_cause as string | null, killerAnimalId: r.killer_animal_id as string | null,
  diedAt: r.died_at as Date | null, diedWorldTime: num(r.died_world_time), cooldownUntil: r.cooldown_until as Date | null, bountyId: r.bounty_id as string | null });
const purchase = (r: Record<string, unknown>): Purchase => ({ purchaseId: r.purchase_id as string, idempotencyKey: r.idempotency_key as string,
  ownerAccountId: r.owner_account_id as string, ownerWallet: r.owner_wallet as string, kind: r.kind as 'buy' | 'sell', speciesId: r.species_id as string,
  priceAtomic: BigInt(r.price_atomic as string), feeAtomic: BigInt(r.fee_atomic as string), decimals: r.decimals as number,
  pricingVersion: r.pricing_version as string, createdAt: r.created_at as Date });
/** A transaction-scoped advisory lock key for one owner. */
const ownerLock = (accountId: string) => createHash('sha256').update(`owner:${accountId}`).digest().readBigInt64BE(0).toString();

export class OwnershipStore {
  constructor(private readonly pool: Pool, readonly worldId: string) {}

  /** Runs `fn` in one transaction. */
  async tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      const result = await fn(db);
      await db.query('commit');
      return result;
    } catch (error) {
      await db.query('rollback').catch(() => undefined);
      throw error;
    } finally { db.release(); }
  }

  // ---- The simulated store ----------------------------------------------------------------

  /** Records a purchase and its ledger rows once per owner and key; a repeat returns the first, with `replayed`. */
  async recordPurchase(p: PurchaseInput, rows: readonly LedgerRow[], db?: Database): Promise<Purchase & { replayed: boolean }> {
    const run = async (q: Database) => {
      const inserted = (await q.query(`insert into sim_purchases (purchase_id, idempotency_key, owner_account_id, owner_wallet, kind, species_id,
          price_atomic, fee_atomic, decimals, pricing_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (owner_account_id, idempotency_key) do nothing returning *`,
        [randomUUID(), p.idempotencyKey, p.ownerAccountId, p.ownerWallet, p.kind, p.speciesId, p.priceAtomic.toString(), p.feeAtomic.toString(), p.decimals, p.pricingVersion])).rows[0];
      if (!inserted) {
        const existing = (await q.query('select * from sim_purchases where owner_account_id=$1 and idempotency_key=$2', [p.ownerAccountId, p.idempotencyKey])).rows[0];
        return { ...purchase(existing), replayed: true };
      }
      await this.ledgerPost(q, rows, inserted.purchase_id as string);
      return { ...purchase(inserted), replayed: false };
    };
    return db ? run(db) : this.tx(run);
  }

  async ledgerPost(db: Database, rows: readonly LedgerRow[], purchaseId: string | null = null): Promise<void> {
    for (const row of rows) {
      await db.query('insert into sim_ledger (category, amount_atomic, decimals, purchase_id, ref) values ($1,$2,$3,$4,$5)',
        [row.category, row.amountAtomic.toString(), row.decimals, purchaseId, row.ref ?? null]);
    }
  }

  /** The SIMULATED reward pool: everything posted to it, less what was taken from it. */
  async poolBalance(db: Database = this.pool): Promise<bigint> {
    const row = (await db.query("select coalesce(sum(amount_atomic), 0)::text as total from sim_ledger where category = 'reward_pool'")).rows[0];
    return BigInt(row.total as string);
  }

  async purchaseByKey(ownerAccountId: string, idempotencyKey: string): Promise<Purchase | null> {
    const row = (await this.pool.query('select * from sim_purchases where owner_account_id=$1 and idempotency_key=$2', [ownerAccountId, idempotencyKey])).rows[0];
    return row ? purchase(row) : null;
  }

  // ---- Assets -------------------------------------------------------------------------------

  async createAsset(p: { ownerAccountId: string; ownerWallet: string; speciesId: string; purchaseId: string; pricingVersion: string; variantId?: string },
    db: Database = this.pool): Promise<Asset> {
    const row = (await db.query(`insert into animal_assets (asset_id, owner_account_id, owner_wallet, species_id, variant_id, purchase_id, pricing_version)
      values ($1,$2,$3,$4,$5,$6,$7) on conflict (purchase_id) do update set purchase_id = excluded.purchase_id returning *`,
    [randomUUID(), p.ownerAccountId, p.ownerWallet, p.speciesId, p.variantId ?? 'standard', p.purchaseId, p.pricingVersion])).rows[0];
    return asset(row);
  }

  async asset(assetId: string, db: Database = this.pool): Promise<Asset | null> {
    const row = (await db.query('select * from animal_assets where asset_id=$1', [assetId])).rows[0];
    return row ? asset(row) : null;
  }

  async assetByPurchase(purchaseId: string): Promise<Asset | null> {
    const row = (await this.pool.query('select * from animal_assets where purchase_id=$1', [purchaseId])).rows[0];
    return row ? asset(row) : null;
  }

  async assetsOf(ownerAccountId: string): Promise<Asset[]> {
    return (await this.pool.query("select * from animal_assets where owner_account_id=$1 and status <> 'retired' order by created_at", [ownerAccountId])).rows.map(asset);
  }

  async setAssetStatus(assetId: string, status: AssetStatus, db: Database = this.pool): Promise<void> {
    await db.query('update animal_assets set status=$2 where asset_id=$1', [assetId, status]);
  }

  // ---- Lives --------------------------------------------------------------------------------

  /**
   * Reserves a new life of an asset, before its animal is spawned: the asset must be its owner's,
   * active, not alive, past any cooldown, and the owner under `maxAlive` living animals. The
   * owner's spawns are serialised by a transaction lock, so a race cannot pass the limit.
   */
  async openLife(p: { assetId: string; ownerAccountId: string; maxAlive: number; now: Date }):
    Promise<{ ok: true; lifeId: string } | { ok: false; reason: 'not_owner' | 'not_active' | 'already_alive' | 'cooldown' | 'alive_limit' }> {
    return this.tx(async (db) => {
      await db.query('select pg_advisory_xact_lock($1::bigint)', [ownerLock(p.ownerAccountId)]);
      // The asset's row is locked, so a sale and a spawn of it run one after the other.
      const a = (await db.query('select * from animal_assets where asset_id=$1 for update', [p.assetId])).rows[0];
      if (!a || a.owner_account_id !== p.ownerAccountId) return { ok: false, reason: 'not_owner' } as const;
      if (a.status !== 'active') return { ok: false, reason: 'not_active' } as const;
      const lives = (await db.query('select status, cooldown_until from animal_lives where asset_id=$1', [p.assetId])).rows;
      if (lives.some((l) => l.status === 'alive')) return { ok: false, reason: 'already_alive' } as const;
      if (lives.some((l) => l.status === 'cooldown' && (l.cooldown_until as Date) > p.now)) return { ok: false, reason: 'cooldown' } as const;
      const alive = (await db.query(`select count(*)::int as n from animal_lives l join animal_assets a using (asset_id)
        where a.owner_account_id=$1 and l.status='alive'`, [p.ownerAccountId])).rows[0].n as number;
      if (alive >= p.maxAlive) return { ok: false, reason: 'alive_limit' } as const;
      const lifeId = randomUUID();
      await db.query("insert into animal_lives (life_id, asset_id, world_id, status) values ($1,$2,$3,'alive')", [lifeId, p.assetId, this.worldId]);
      return { ok: true, lifeId } as const;
    });
  }

  /** The spawned animal of a reserved life. */
  async attachAnimal(lifeId: string, animalId: string, patchId: number, worldTime: number): Promise<void> {
    await this.pool.query('update animal_lives set animal_id=$2, spawn_patch_id=$3, spawned_world_time=$4 where life_id=$1',
      [lifeId, animalId, patchId, worldTime]);
  }

  /** A reserved life whose spawn failed: as if it never was. */
  async discardLife(lifeId: string): Promise<void> {
    await this.pool.query('delete from animal_lives where life_id=$1 and animal_id is null', [lifeId]);
  }

  /**
   * Ends an alive life once: its cause, killer and time, the cooldown before the asset may live
   * again, and any open lease. Returns false if it had already ended.
   */
  async endLife(lifeId: string, p: { cause: string; killerAnimalId: string | null; worldTime: number | null; cooldownMs: number; now: Date }): Promise<boolean> {
    return this.tx(async (db) => {
      const ended = await db.query(`update animal_lives set status='cooldown', death_cause=$2, killer_animal_id=$3, died_world_time=$4,
        died_at=$5, cooldown_until=$6 where life_id=$1 and status='alive'`,
      [lifeId, p.cause, p.killerAnimalId, p.worldTime, p.now, new Date(p.now.getTime() + p.cooldownMs)]);
      if (ended.rowCount === 0) return false;
      await db.query("update control_leases set ended_at=$2, end_reason='died' where life_id=$1 and ended_at is null", [lifeId, p.now]);
      return true;
    });
  }

  /** Cooldowns that have run out become plain deaths. Returns how many. */
  async settleCooldowns(now: Date): Promise<number> {
    return (await this.pool.query("update animal_lives set status='dead' where status='cooldown' and cooldown_until <= $1", [now])).rowCount ?? 0;
  }

  async life(lifeId: string): Promise<Life | null> {
    const row = (await this.pool.query('select * from animal_lives where life_id=$1', [lifeId])).rows[0];
    return row ? life(row) : null;
  }

  async lifeOfAnimal(animalId: string): Promise<Life | null> {
    const row = (await this.pool.query('select * from animal_lives where animal_id=$1', [animalId])).rows[0];
    return row ? life(row) : null;
  }

  async livesOf(assetId: string): Promise<Life[]> {
    return (await this.pool.query('select * from animal_lives where asset_id=$1 order by spawned_at', [assetId])).rows.map(life);
  }

  /** Every life alive in this world. */
  async aliveLives(): Promise<Life[]> {
    return (await this.pool.query("select * from animal_lives where status='alive' and world_id=$1", [this.worldId])).rows.map(life);
  }

  // ---- Control leases -----------------------------------------------------------------------

  /**
   * Gives a life a new controller: in one transaction, with the life's row locked, the open
   * lease (if any) ends as a handover and the new one opens. Returns the holder it replaced.
   */
  async openLease(lifeId: string, holder: { kind: HolderKind; id: string }):
    Promise<{ ok: true; lease: Lease; previous: { kind: HolderKind; id: string } | null } | { ok: false; reason: 'not_alive' }> {
    return this.tx(async (db) => {
      const row = (await db.query('select status from animal_lives where life_id=$1 for update', [lifeId])).rows[0];
      if (!row || row.status !== 'alive') return { ok: false, reason: 'not_alive' } as const;
      const ended = (await db.query(`update control_leases set ended_at=now(), end_reason='handover' where life_id=$1 and ended_at is null
        returning holder_kind, holder_id`, [lifeId])).rows[0];
      const lease = (await db.query(`insert into control_leases (lease_id, life_id, holder_kind, holder_id) values ($1,$2,$3,$4) returning *`,
        [randomUUID(), lifeId, holder.kind, holder.id])).rows[0];
      return { ok: true, lease: { leaseId: lease.lease_id, lifeId, holderKind: holder.kind, holderId: holder.id, startedAt: lease.started_at },
        previous: ended ? { kind: ended.holder_kind as HolderKind, id: ended.holder_id as string } : null } as const;
    });
  }

  /** Ends the life's open lease, if any. Returns whether one was open. */
  async endLease(lifeId: string, reason: string): Promise<boolean> {
    return ((await this.pool.query('update control_leases set ended_at=now(), end_reason=$2 where life_id=$1 and ended_at is null', [lifeId, reason])).rowCount ?? 0) > 0;
  }

  async openLeaseOf(lifeId: string): Promise<Lease | null> {
    const r = (await this.pool.query('select * from control_leases where life_id=$1 and ended_at is null', [lifeId])).rows[0];
    return r ? { leaseId: r.lease_id, lifeId, holderKind: r.holder_kind, holderId: r.holder_id, startedAt: r.started_at } : null;
  }

  /** Every open lease in this world, for a restart to restore. */
  async openLeases(): Promise<Array<Lease & { animalId: string }>> {
    return (await this.pool.query(`select c.*, l.animal_id from control_leases c join animal_lives l using (life_id)
      where c.ended_at is null and l.status='alive' and l.world_id=$1 and l.animal_id is not null`, [this.worldId])).rows
      .map((r) => ({ leaseId: r.lease_id, lifeId: r.life_id, holderKind: r.holder_kind, holderId: r.holder_id, startedAt: r.started_at, animalId: r.animal_id }));
  }

  // ---- Agent grants -------------------------------------------------------------------------

  /** Authorises an agent to steer an asset. Returns false if it already was. */
  async grant(assetId: string, agentId: string): Promise<boolean> {
    return ((await this.pool.query('insert into asset_agent_grants (asset_id, agent_id) values ($1,$2) on conflict do nothing', [assetId, agentId])).rowCount ?? 0) > 0;
  }

  async revoke(assetId: string, agentId: string): Promise<boolean> {
    return ((await this.pool.query('update asset_agent_grants set revoked_at=now() where asset_id=$1 and agent_id=$2 and revoked_at is null', [assetId, agentId])).rowCount ?? 0) > 0;
  }

  async granted(assetId: string, agentId: string): Promise<boolean> {
    return (await this.pool.query('select 1 from asset_agent_grants where asset_id=$1 and agent_id=$2 and revoked_at is null', [assetId, agentId])).rows.length > 0;
  }

  async grantsOf(assetId: string): Promise<string[]> {
    return (await this.pool.query('select agent_id from asset_agent_grants where asset_id=$1 and revoked_at is null order by granted_at', [assetId])).rows.map((r) => r.agent_id as string);
  }
}
