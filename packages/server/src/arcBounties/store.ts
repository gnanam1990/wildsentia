import type { Pool } from '../db/pool.js';

/** Congo bounties paid on Arc: the server's record of each (migration 034). */
export type ArcBountyStatus = 'publishing' | 'active' | 'deciding' | 'paid' | 'voided' | 'failed';
export type ArcOutcome = 'predator' | 'survived' | 'void';
export interface ArcBounty {
  bountyId: string; worldId: string; status: ArcBountyStatus;
  targetAnimalId: string; targetSpeciesId: string; targetRegion: string; targetAgentId: string | null; targetWallet: string | null;
  targetKey: string; salt: string; amountAtomic: bigint; windowWorldSeconds: number;
  publishedWorldTime: number; deadlineWorldTime: number; expiresAt: Date; eligiblePredators: string[];
  rules: Record<string, unknown>; rulesHash: string; notified: boolean;
  killAgentId: string | null; killAnimalId: string | null; killWorldTime: number | null; killPreyAgentId: string | null;
  outcome: ArcOutcome | null; payeeWallet: string | null; winnerAgentId: string | null; winnerAnimalId: string | null; winnerOwner: string | null;
  decidedWorldTime: number | null; record: unknown; recordHash: string | null;
  publishTx: string | null; publishSentAt: Date | null; decideTx: string | null; decideSentAt: Date | null; error: string | null;
  createdAt: Date; decidedAt: Date | null; settledAt: Date | null;
}
export interface NewArcBounty {
  bountyId: string; targetAnimalId: string; targetSpeciesId: string; targetRegion: string; targetAgentId: string | null; targetWallet: string | null;
  targetKey: string; salt: string; amountAtomic: bigint; windowWorldSeconds: number; publishedWorldTime: number;
  deadlineWorldTime: number; expiresAt: Date; eligiblePredators: string[]; rules: Record<string, unknown>; rulesHash: string;
}
export interface ArcDecision {
  outcome: ArcOutcome; payeeWallet: string | null; winnerAgentId: string | null; winnerAnimalId: string | null;
  /** Who owns the paid agent (for the owner's daily cap); null when nobody is paid. */
  winnerOwner?: string | null;
  decidedWorldTime: number; record: unknown; recordHash: string;
}

const n = (v: unknown): number | null => v === null || v === undefined ? null : Number(v);
const row = (r: Record<string, unknown>): ArcBounty => ({
  bountyId: r.bounty_id as string, worldId: r.world_id as string, status: r.status as ArcBountyStatus,
  targetAnimalId: r.target_animal_id as string, targetSpeciesId: r.target_species_id as string, targetRegion: r.target_region as string,
  targetAgentId: r.target_agent_id as string | null, targetWallet: r.target_wallet as string | null, targetKey: r.target_key as string, salt: r.salt as string,
  amountAtomic: BigInt(r.amount_atomic as string), windowWorldSeconds: Number(r.window_world_seconds),
  publishedWorldTime: Number(r.published_world_time), deadlineWorldTime: Number(r.deadline_world_time), expiresAt: r.expires_at as Date,
  eligiblePredators: r.eligible_predators as string[], rules: r.rules as Record<string, unknown>, rulesHash: r.rules_hash as string,
  notified: r.notified as boolean, killAgentId: r.kill_agent_id as string | null, killAnimalId: r.kill_animal_id as string | null,
  killWorldTime: n(r.kill_world_time), killPreyAgentId: r.kill_prey_agent_id as string | null, outcome: r.outcome as ArcOutcome | null, payeeWallet: r.payee_wallet as string | null,
  winnerAgentId: r.winner_agent_id as string | null, winnerAnimalId: r.winner_animal_id as string | null, winnerOwner: (r.winner_owner as string | null) ?? null,
  decidedWorldTime: n(r.decided_world_time),
  record: r.record, recordHash: r.record_hash as string | null, publishTx: r.publish_tx as string | null, publishSentAt: r.publish_sent_at as Date | null,
  decideTx: r.decide_tx as string | null, decideSentAt: r.decide_sent_at as Date | null, error: r.error as string | null,
  createdAt: r.created_at as Date, decidedAt: r.decided_at as Date | null, settledAt: r.settled_at as Date | null,
});

export class ArcBountyStore {
  constructor(private readonly pool: Pool, readonly worldId: string) {}

  /** A new bounty, before its publish transaction is sent. False if the animal already carries one. */
  async create(b: NewArcBounty): Promise<boolean> {
    const r = await this.pool.query(`insert into arc_bounties (bounty_id, world_id, status, target_animal_id, target_species_id, target_region,
        target_agent_id, target_wallet, target_key, salt, amount_atomic, window_world_seconds, published_world_time, deadline_world_time,
        expires_at, eligible_predators, rules, rules_hash)
      values ($1, $2, 'publishing', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      on conflict do nothing`,
    [b.bountyId, this.worldId, b.targetAnimalId, b.targetSpeciesId, b.targetRegion, b.targetAgentId, b.targetWallet?.toLowerCase() ?? null, b.targetKey,
      b.salt, b.amountAtomic.toString(), b.windowWorldSeconds, b.publishedWorldTime, b.deadlineWorldTime, b.expiresAt, b.eligiblePredators,
      JSON.stringify(b.rules), b.rulesHash]);
    return r.rowCount === 1;
  }

  async get(bountyId: string): Promise<ArcBounty | null> {
    const r = await this.pool.query('select * from arc_bounties where bounty_id = $1', [bountyId]);
    return r.rows[0] ? row(r.rows[0]) : null;
  }

  /** This world's bounties in these states, oldest first. */
  async inStatus(...statuses: ArcBountyStatus[]): Promise<ArcBounty[]> {
    const r = await this.pool.query('select * from arc_bounties where world_id = $1 and status = any($2) order by created_at', [this.worldId, statuses]);
    return r.rows.map(row);
  }

  async recent(limit = 50): Promise<ArcBounty[]> {
    const r = await this.pool.query('select * from arc_bounties where world_id = $1 order by created_at desc limit $2', [this.worldId, limit]);
    return r.rows.map(row);
  }

  /** The animals that carry a live bounty in this world. */
  async liveTargets(): Promise<Set<string>> {
    return new Set((await this.inStatus('publishing', 'active', 'deciding')).map((b) => b.targetAnimalId));
  }

  /** A transaction's hash, stored before it is sent. */
  async sending(bountyId: string, which: 'publish' | 'decide', hash: string): Promise<void> {
    await this.pool.query(`update arc_bounties set ${which}_tx = $2, ${which}_sent_at = now() where bounty_id = $1`, [bountyId, hash]);
  }

  async published(bountyId: string): Promise<void> {
    await this.pool.query(`update arc_bounties set status = 'active', error = null where bounty_id = $1 and status = 'publishing'`, [bountyId]);
  }

  async failed(bountyId: string, error: string): Promise<void> {
    await this.pool.query(`update arc_bounties set status = 'failed', error = $2 where bounty_id = $1 and status = 'publishing'`, [bountyId, error.slice(0, 500)]);
  }

  async setNotified(bountyId: string): Promise<void> {
    await this.pool.query('update arc_bounties set notified = true where bounty_id = $1', [bountyId]);
  }

  /** A live kill of the target, recorded the moment it happens; the first one only. */
  async recordKill(bountyId: string, kill: { agentId: string | null; animalId: string; worldTime: number; preyAgentId: string | null }): Promise<boolean> {
    const r = await this.pool.query(`update arc_bounties set kill_agent_id = $2, kill_animal_id = $3, kill_world_time = $4, kill_prey_agent_id = $5
      where bounty_id = $1 and status = 'active' and kill_animal_id is null`, [bountyId, kill.agentId, kill.animalId, kill.worldTime, kill.preyAgentId]);
    return r.rowCount === 1;
  }

  /** The bounty's one decision. False if it was already decided. */
  async decide(bountyId: string, d: ArcDecision): Promise<boolean> {
    const r = await this.pool.query(`update arc_bounties set status = 'deciding', outcome = $2, payee_wallet = $3, winner_agent_id = $4,
        winner_animal_id = $5, decided_world_time = $6, record = $7, record_hash = $8, winner_owner = $9, decided_at = now()
      where bounty_id = $1 and status = 'active'`,
    [bountyId, d.outcome, d.payeeWallet?.toLowerCase() ?? null, d.winnerAgentId, d.winnerAnimalId, d.decidedWorldTime, JSON.stringify(d.record), d.recordHash,
      d.outcome === 'void' ? null : d.winnerOwner ?? null]);
    return r.rowCount === 1;
  }

  /** The decision's transaction is confirmed on chain (or the chain shows it done). */
  async settled(bountyId: string, onChain: 'paid' | 'voided'): Promise<void> {
    // The chain is the truth: a decision returned to the pool (expired, or refused) paid nobody, whatever was decided.
    await this.pool.query(`update arc_bounties set status = $2, settled_at = now(), error = null,
        outcome = case when $2 = 'voided' then 'void' else outcome end, payee_wallet = case when $2 = 'voided' then null else payee_wallet end
      where bounty_id = $1 and status = 'deciding'`, [bountyId, onChain]);
  }

  /** USDC this world's bounties reserved since a time (all but those that never reached the chain): for the daily cap. */
  async publishedSince(since: Date): Promise<bigint> {
    const r = await this.pool.query<{ amount: string | null }>(
      `select sum(amount_atomic) as amount from arc_bounties where world_id = $1 and created_at >= $2 and status <> 'failed'`, [this.worldId, since]);
    return BigInt(r.rows[0]?.amount ?? 0);
  }

  /**
   * USDC decided for one owner since a time, in every world, paid or on its way (a decision the
   * chain returned to the pool counts nothing): for the owner's daily cap.
   */
  async wonSince(owner: string, since: Date): Promise<bigint> {
    const r = await this.pool.query<{ amount: string | null }>(`select sum(amount_atomic) as amount from arc_bounties
      where winner_owner = $1 and decided_at >= $2 and status in ('deciding', 'paid') and outcome in ('predator', 'survived')`, [owner, since]);
    return BigInt(r.rows[0]?.amount ?? 0);
  }

  /** This world's bounties by state: how many, and how much USDC. */
  async totals(): Promise<Record<ArcBountyStatus, { count: number; amountAtomic: bigint }>> {
    const r = await this.pool.query<{ status: ArcBountyStatus; count: string; amount: string | null }>(
      'select status, count(*) as count, sum(amount_atomic) as amount from arc_bounties where world_id = $1 group by status', [this.worldId]);
    const out = Object.fromEntries((['publishing', 'active', 'deciding', 'paid', 'voided', 'failed'] as const)
      .map((s) => [s, { count: 0, amountAtomic: 0n }])) as Record<ArcBountyStatus, { count: number; amountAtomic: bigint }>;
    for (const row of r.rows) out[row.status] = { count: Number(row.count), amountAtomic: BigInt(row.amount ?? '0') };
    return out;
  }

  /**
   * The agents that won bounties paid since `since` (all time when null), most USDC first: their
   * name, kills (hunter won), escapes (prey survived) and USDC won.
   */
  async leaderboard(since: Date | null, limit = 20): Promise<Array<{ agentId: string; name: string | null; kills: number; escapes: number; wonAtomic: bigint }>> {
    const r = await this.pool.query<{ agent_id: string; name: string | null; kills: string; escapes: string; won: string }>(
      `select b.winner_agent_id as agent_id, max(a.name) as name,
          count(*) filter (where b.outcome = 'predator') as kills, count(*) filter (where b.outcome = 'survived') as escapes,
          sum(b.amount_atomic) as won
        from arc_bounties b left join live_agents a on a.id = b.winner_agent_id
        where b.world_id = $1 and b.status = 'paid' and b.winner_agent_id is not null and ($2::timestamptz is null or b.settled_at >= $2)
        group by b.winner_agent_id order by sum(b.amount_atomic) desc, count(*) desc, b.winner_agent_id limit $3`, [this.worldId, since, limit]);
    return r.rows.map((x) => ({ agentId: x.agent_id, name: x.name, kills: Number(x.kills), escapes: Number(x.escapes), wonAtomic: BigInt(x.won) }));
  }

  async noteError(bountyId: string, error: string): Promise<void> {
    await this.pool.query('update arc_bounties set error = $2 where bounty_id = $1', [bountyId, error.slice(0, 500)]);
  }
}
