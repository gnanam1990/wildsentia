import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Database, Pool } from '../db/pool.js';

/**
 * Congo 1D (spec §5): bounties on owned animals' lives. Publishing reserves the whole reward out
 * of the SIMULATED reward pool; one outcome per bounty; one settlement per bounty, written as an
 * intent before it is recorded, so a restart or a replay never pays twice.
 */

export type BountyStatus = 'draft' | 'validated' | 'active' | 'on_hold' | 'adjudicated' | 'settled' | 'cancelled';
export type Preset = 'standard' | 'hard' | 'elite';
export type Outcome = 'predator' | 'survived' | 'void';
export interface Bounty {
  bountyId: string; status: BountyStatus; preset: Preset; worldId: string;
  targetLifeId: string; targetAnimalId: string; targetSpeciesId: string; targetRegion: string; targetAssetId: string;
  targetOwnerAccountId: string; targetOwnerWallet: string;
  amountAtomic: bigint; decimals: number; windowWorldSeconds: number;
  publishedWorldTime: number | null; deadlineWorldTime: number | null; publishedAt: Date | null;
  eligiblePredators: string[]; rules: Record<string, unknown>; rulesHash: string | null; validation: Record<string, unknown> | null;
  outcome: Outcome | null; winnerWallet: string | null; winnerAnimalId: string | null; decidedWorldTime: number | null;
  adjudicatedAt: Date | null; cancelReason: string | null; holdReason: string | null; createdAt: Date;
  /** An admin resumed it after an outage hold: decided normally from then on. */
  holdCleared: boolean;
}
export interface Settlement { settlementId: string; bountyId: string; payeeWallet: string; amountAtomic: bigint; decimals: number; status: 'intent' | 'recorded' }

const n = (v: unknown): number | null => v === null || v === undefined ? null : Number(v);
const bounty = (r: Record<string, unknown>): Bounty => ({
  bountyId: r.bounty_id as string, status: r.status as BountyStatus, preset: r.preset as Preset, worldId: r.world_id as string,
  targetLifeId: r.target_life_id as string, targetAnimalId: r.target_animal_id as string, targetSpeciesId: r.target_species_id as string,
  targetRegion: r.target_region as string, targetAssetId: r.target_asset_id as string,
  targetOwnerAccountId: r.target_owner_account_id as string, targetOwnerWallet: r.target_owner_wallet as string,
  amountAtomic: BigInt(r.amount_atomic as string), decimals: r.decimals as number, windowWorldSeconds: Number(r.window_world_seconds),
  publishedWorldTime: n(r.published_world_time), deadlineWorldTime: n(r.deadline_world_time), publishedAt: r.published_at as Date | null,
  eligiblePredators: r.eligible_predators as string[], rules: r.rules as Record<string, unknown>, rulesHash: r.rules_hash as string | null,
  validation: r.validation as Record<string, unknown> | null, outcome: r.outcome as Outcome | null, winnerWallet: r.winner_wallet as string | null,
  winnerAnimalId: r.winner_animal_id as string | null, decidedWorldTime: n(r.decided_world_time), adjudicatedAt: r.adjudicated_at as Date | null,
  cancelReason: r.cancel_reason as string | null, holdReason: r.hold_reason as string | null, createdAt: r.created_at as Date,
  holdCleared: r.hold_cleared === true,
});
const settlement = (r: Record<string, unknown>): Settlement => ({ settlementId: r.settlement_id as string, bountyId: r.bounty_id as string,
  payeeWallet: r.payee_wallet as string, amountAtomic: BigInt(r.amount_atomic as string), decimals: r.decimals as number, status: r.status as 'intent' | 'recorded' });

/** The canonical hash of a bounty's locked terms. */
export function rulesHash(terms: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(terms))).digest('hex');
}

/** The one lock every reservation of the pool takes, so concurrent publishes cannot overdraw it. */
const POOL_LOCK = '7351602240119513361';

export class BountyStore {
  constructor(private readonly pool: Pool, readonly worldId: string) {}

  async tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query('begin'); const r = await fn(db); await db.query('commit'); return r; }
    catch (error) { await db.query('rollback').catch(() => undefined); throw error; }
    finally { db.release(); }
  }

  async createDraft(p: { preset: Preset; targetLifeId: string; targetAnimalId: string; targetSpeciesId: string; targetRegion: string;
    targetAssetId: string; targetOwnerAccountId: string; targetOwnerWallet: string; amountAtomic: bigint; decimals: number;
    windowWorldSeconds: number; eligiblePredators: string[]; rules: Record<string, unknown> }): Promise<Bounty> {
    const row = (await this.pool.query(`insert into bounties (bounty_id, status, preset, world_id, target_life_id, target_animal_id, target_species_id,
        target_region, target_asset_id, target_owner_account_id, target_owner_wallet, amount_atomic, decimals, window_world_seconds, eligible_predators, rules)
      values ($1,'draft',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
    [randomUUID(), p.preset, this.worldId, p.targetLifeId, p.targetAnimalId, p.targetSpeciesId, p.targetRegion, p.targetAssetId,
      p.targetOwnerAccountId, p.targetOwnerWallet, p.amountAtomic.toString(), p.decimals, p.windowWorldSeconds, p.eligiblePredators, p.rules])).rows[0];
    return bounty(row);
  }

  async get(bountyId: string, db: Database = this.pool): Promise<Bounty | null> {
    const row = (await db.query('select * from bounties where bounty_id=$1', [bountyId])).rows[0];
    return row ? bounty(row) : null;
  }

  async list(): Promise<Bounty[]> {
    return (await this.pool.query('select * from bounties where world_id=$1 order by created_at desc limit 200', [this.worldId])).rows.map(bounty);
  }

  /** Active (and held) bounties of this world. */
  async active(): Promise<Bounty[]> {
    return (await this.pool.query("select * from bounties where world_id=$1 and status in ('active','on_hold') order by published_at", [this.worldId])).rows.map(bounty);
  }

  /** Bounties left active or held by an earlier world (founded again since). */
  async activeElsewhere(): Promise<Bounty[]> {
    return (await this.pool.query("select * from bounties where world_id<>$1 and status in ('active','on_hold')", [this.worldId])).rows.map(bounty);
  }

  /**
   * An asset's most recently decided bounty, as its owner sees it: on the asset's own animal
   * (target) or one its animal won (winner), its payout, and whether that payout is the owner's.
   */
  async lastDecidedOnAsset(assetId: string): Promise<{ outcome: Outcome; role: 'target' | 'winner'; payout: { status: 'intent' | 'recorded' } | null; paidToOwner: boolean } | null> {
    const row = (await this.pool.query(`select b.outcome, s.status as payout, s.payee_wallet, a.owner_wallet,
        case when b.target_asset_id=$1 then 'target' else 'winner' end as role
      from bounties b left join bounty_settlements s using (bounty_id) join animal_assets a on a.asset_id=$1
      where b.outcome is not null and (b.target_asset_id=$1 or (b.outcome='predator' and b.winner_animal_id in
        (select animal_id from animal_lives where asset_id=$1 and animal_id is not null)))
      order by b.adjudicated_at desc limit 1`, [assetId])).rows[0];
    return row ? { outcome: row.outcome as Outcome, role: row.role as 'target' | 'winner', payout: row.payout ? { status: row.payout as 'intent' | 'recorded' } : null,
      paidToOwner: !!row.payee_wallet && row.payee_wallet === row.owner_wallet } : null;
  }

  /** The active bounty on a life, if any. */
  async activeOnLife(lifeId: string): Promise<Bounty | null> {
    const row = (await this.pool.query("select * from bounties where target_life_id=$1 and status in ('active','on_hold')", [lifeId])).rows[0];
    return row ? bounty(row) : null;
  }

  async setValidation(bountyId: string, validation: Record<string, unknown>, ok: boolean): Promise<boolean> {
    return ((await this.pool.query(`update bounties set validation=$2, status=case when $3 then 'validated' else 'draft' end
      where bounty_id=$1 and status in ('draft','validated')`, [bountyId, validation, ok])).rowCount ?? 0) > 0;
  }

  /**
   * Publishes a validated bounty: the terms lock (rules hash), the deadline is set in world time,
   * the whole reward is reserved out of the pool (which must hold it) and the target's asset locks.
   */
  async publish(bountyId: string, publishedWorldTime: number): Promise<{ ok: true; bounty: Bounty } | { ok: false; reason: 'not_validated' | 'unfunded' | 'target_has_bounty' }> {
    return this.tx(async (db) => {
      await db.query('select pg_advisory_xact_lock($1::bigint)', [POOL_LOCK]);
      const b = (await db.query('select * from bounties where bounty_id=$1 for update', [bountyId])).rows[0];
      if (!b || b.status !== 'validated') return { ok: false, reason: 'not_validated' } as const;
      const pool = BigInt((await db.query("select coalesce(sum(amount_atomic),0)::text as t from sim_ledger where category='reward_pool'")).rows[0].t as string);
      if (pool < BigInt(b.amount_atomic as string)) return { ok: false, reason: 'unfunded' } as const;
      const taken = (await db.query("select 1 from bounties where target_life_id=$1 and status in ('active','on_hold','adjudicated') and bounty_id<>$2",
        [b.target_life_id, bountyId])).rows.length;
      if (taken) return { ok: false, reason: 'target_has_bounty' } as const;
      const deadline = publishedWorldTime + Number(b.window_world_seconds);
      const terms = { bountyId, preset: b.preset, targetLifeId: b.target_life_id, targetAnimalId: b.target_animal_id, amountAtomic: String(b.amount_atomic),
        decimals: b.decimals, publishedWorldTime, deadlineWorldTime: deadline, eligiblePredators: b.eligible_predators, rules: b.rules,
        survivalPayee: b.target_owner_wallet };
      const row = (await db.query(`update bounties set status='active', published_world_time=$2, deadline_world_time=$3, published_at=now(), rules_hash=$4
        where bounty_id=$1 returning *`, [bountyId, publishedWorldTime, deadline, rulesHash(terms)])).rows[0];
      await db.query("insert into sim_ledger (category, amount_atomic, decimals, ref) values ('reward_pool', $1, $2, $3)",
        [(-BigInt(b.amount_atomic as string)).toString(), b.decimals, `bounty:${bountyId}:reserve`]);
      await db.query("update animal_assets set status='locked' where asset_id=$1 and status='active'", [b.target_asset_id]);
      return { ok: true, bounty: bounty(row) } as const;
    });
  }

  /** Cancels a draft or an active bounty: the reason recorded, the reservation returned, the asset unlocked. */
  async cancel(bountyId: string, reason: string): Promise<boolean> {
    return this.tx(async (db) => {
      const b = (await db.query('select * from bounties where bounty_id=$1 for update', [bountyId])).rows[0];
      if (!b || !['draft', 'validated', 'active', 'on_hold'].includes(b.status as string)) return false;
      await db.query("update bounties set status='cancelled', cancel_reason=$2 where bounty_id=$1", [bountyId, reason]);
      if (b.status === 'active' || b.status === 'on_hold') {
        await db.query("insert into sim_ledger (category, amount_atomic, decimals, ref) values ('reward_pool', $1, $2, $3)",
          [String(b.amount_atomic), b.decimals, `bounty:${bountyId}:return`]);
        await db.query("update animal_assets set status='active' where asset_id=$1 and status='locked'", [b.target_asset_id]);
      }
      return true;
    });
  }

  async hold(bountyId: string, reason: string): Promise<boolean> {
    return ((await this.pool.query("update bounties set status='on_hold', hold_reason=$2 where bounty_id=$1 and status='active'", [bountyId, reason])).rowCount ?? 0) > 0;
  }

  /** Releases a held bounty back to adjudication (an admin's review). */
  async resume(bountyId: string): Promise<boolean> {
    return ((await this.pool.query("update bounties set status='active', hold_reason=null, hold_cleared=true where bounty_id=$1 and status='on_hold'", [bountyId])).rowCount ?? 0) > 0;
  }

  /**
   * Decides an active bounty once. A void outcome returns the reservation and settles at once;
   * a payout gets its settlement intent in the same transaction. Returns false if already decided.
   */
  async decide(bountyId: string, d: { outcome: Outcome; payeeWallet: string | null; winnerAnimalId: string | null; worldTime: number }): Promise<boolean> {
    return this.tx(async (db) => {
      const b = (await db.query("select * from bounties where bounty_id=$1 and status in ('active','on_hold') for update", [bountyId])).rows[0];
      if (!b) return false;
      if (d.outcome !== 'void' && !d.payeeWallet) throw new Error('a payout needs a payee');
      await db.query(`update bounties set status=$2, outcome=$3, winner_wallet=$4, winner_animal_id=$5, decided_world_time=$6, adjudicated_at=now()
        where bounty_id=$1`, [bountyId, d.outcome === 'void' ? 'settled' : 'adjudicated', d.outcome, d.payeeWallet, d.winnerAnimalId, d.worldTime]);
      if (d.outcome === 'void') {
        await db.query("insert into sim_ledger (category, amount_atomic, decimals, ref) values ('reward_pool', $1, $2, $3)",
          [String(b.amount_atomic), b.decimals, `bounty:${bountyId}:return`]);
        await db.query("update animal_assets set status='active' where asset_id=$1 and status='locked'", [b.target_asset_id]);
      } else {
        await db.query(`insert into bounty_settlements (settlement_id, bounty_id, payee_wallet, amount_atomic, decimals, status)
          values ($1,$2,$3,$4,$5,'intent') on conflict (bounty_id) do nothing`, [randomUUID(), bountyId, d.payeeWallet, String(b.amount_atomic), b.decimals]);
      }
      return true;
    });
  }

  /** Settlements written but not yet recorded (a restart finishes them). */
  async pendingSettlements(): Promise<Settlement[]> {
    return (await this.pool.query(`select s.* from bounty_settlements s join bounties b using (bounty_id)
      where s.status='intent' and b.world_id=$1`, [this.worldId])).rows.map(settlement);
  }

  async settlementOf(bountyId: string): Promise<Settlement | null> {
    const row = (await this.pool.query('select * from bounty_settlements where bounty_id=$1', [bountyId])).rows[0];
    return row ? settlement(row) : null;
  }

  /**
   * Records an intended payout once: the SIMULATED payout posted, the settlement recorded, the
   * bounty settled and the asset unlocked, in one transaction. A second call does nothing.
   */
  async recordSettlement(bountyId: string): Promise<boolean> {
    return this.tx(async (db) => {
      const s = (await db.query("update bounty_settlements set status='recorded', recorded_at=now() where bounty_id=$1 and status='intent' returning *",
        [bountyId])).rows[0];
      if (!s) return false;
      await db.query("insert into sim_ledger (category, amount_atomic, decimals, ref) values ('payout', $1, $2, $3)",
        [String(s.amount_atomic), s.decimals, `bounty:${bountyId}:payout:${s.payee_wallet}`]);
      const b = (await db.query("update bounties set status='settled' where bounty_id=$1 returning target_asset_id", [bountyId])).rows[0];
      await db.query("update animal_assets set status='active' where asset_id=$1 and status='locked'", [b.target_asset_id]);
      return true;
    });
  }

  /** Remembers the first time an agent's animal perceived a bounty's target. */
  async recordEntrant(bountyId: string, agentId: string, animalId: string, worldTime: number): Promise<boolean> {
    return ((await this.pool.query(`insert into bounty_entrants (bounty_id, agent_id, animal_id, first_seen_world_time) values ($1,$2,$3,$4)
      on conflict do nothing`, [bountyId, agentId, animalId, worldTime])).rowCount ?? 0) > 0;
  }

  async entrants(bountyId: string): Promise<Array<{ agentId: string; animalId: string; firstSeenWorldTime: number }>> {
    return (await this.pool.query('select * from bounty_entrants where bounty_id=$1 order by first_seen_world_time', [bountyId])).rows
      .map((r) => ({ agentId: r.agent_id as string, animalId: r.animal_id as string, firstSeenWorldTime: Number(r.first_seen_world_time) }));
  }

  async saveRecord(bountyId: string, events: unknown[]): Promise<string> {
    const sha256 = createHash('sha256').update(JSON.stringify(events)).digest('hex');
    await this.pool.query('insert into bounty_records (bounty_id, events, sha256) values ($1,$2,$3) on conflict (bounty_id) do nothing',
      [bountyId, JSON.stringify(events), sha256]);
    return sha256;
  }

  async record(bountyId: string): Promise<{ events: unknown[]; sha256: string } | null> {
    const row = (await this.pool.query('select events, sha256 from bounty_records where bounty_id=$1', [bountyId])).rows[0];
    return row ? { events: row.events as unknown[], sha256: row.sha256 as string } : null;
  }
}
