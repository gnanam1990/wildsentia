import { randomUUID } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import type { ChallengeTerms } from './terms.js';

/** PostgreSQL for challenges (migration 019_challenges.sql). Addresses and hashes are lower case. */

export type Hex = `0x${string}`;
export type ChallengeStatus = 'open' | 'won' | 'paid' | 'unpaid' | 'refunding' | 'refunded' | 'unrecognised';
export type AttemptStatus = 'running' | 'met' | 'failed' | 'void';
export type ChainOpKind = 'relay_create' | 'resolve' | 'refund';
export type ChainOpStatus = 'pending' | 'sent' | 'confirmed' | 'failed';

export interface Draft {
  id: string; creatorWallet: string; terms: ChallengeTerms; rulesHash: Hex; prizeAtomic: string; deadline: Date;
  salt: Hex; authNonce: Hex; createdAt: Date; relayedAt: Date | null;
}
export interface Challenge {
  id: number; contract: string; draftId: string | null; creatorWallet: string; terms: ChallengeTerms | null; rulesHash: Hex;
  prizeAtomic: string; deadline: Date; authNonce: Hex; status: ChallengeStatus; winnerAttempt: string | null;
  createdTx: Hex; createdBlock: number; settledTx: Hex | null;
}
export interface Attempt {
  id: string; challengeId: number; agentId: string; animalId: string; payoutWallet: string; startedAt: Date; startedWorld: number;
  startState: Record<string, unknown>; kills: number; escapes: number; status: AttemptStatus; endedAt: Date | null;
  endedWorld: number | null; endReason: string | null; resultRecord: string | null; resultHash: Hex | null;
  /** The player's name, where the query joined it. */
  agentName?: string;
}
export interface LogEntry { at: Date; kind: string; data: Record<string, unknown> }
export interface ChainOp {
  id: string; kind: ChainOpKind; challengeId: number | null; draftId: string | null; payload: Record<string, unknown>;
  status: ChainOpStatus; txHash: Hex | null; tries: number; lastError: string | null; updatedAt: Date;
}
/** A ChallengeCreated event as the indexer read it. */
export interface CreatedEvent {
  id: number; creator: string; prizeAtomic: string; deadline: number; rulesHash: Hex; authNonce: Hex; txHash: Hex; blockNumber: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const draft = (r: any): Draft => ({ id: r.id, creatorWallet: r.creator_wallet, terms: r.terms, rulesHash: r.rules_hash,
  prizeAtomic: String(r.prize_atomic), deadline: r.deadline, salt: r.salt, authNonce: r.auth_nonce, createdAt: r.created_at, relayedAt: r.relayed_at });
const challenge = (r: any): Challenge => ({ id: Number(r.id), contract: r.contract, draftId: r.draft_id, creatorWallet: r.creator_wallet,
  terms: r.terms, rulesHash: r.rules_hash, prizeAtomic: String(r.prize_atomic), deadline: r.deadline, authNonce: r.auth_nonce,
  status: r.status, winnerAttempt: r.winner_attempt, createdTx: r.created_tx, createdBlock: Number(r.created_block), settledTx: r.settled_tx });
const attempt = (r: any): Attempt => ({ id: r.id, challengeId: Number(r.challenge_id), agentId: r.agent_id, animalId: r.animal_id,
  payoutWallet: r.payout_wallet, startedAt: r.started_at, startedWorld: Number(r.started_world), startState: r.start_state,
  kills: r.kills, escapes: r.escapes, status: r.status, endedAt: r.ended_at, endedWorld: r.ended_world === null ? null : Number(r.ended_world),
  endReason: r.end_reason, resultRecord: r.result_record, resultHash: r.result_hash, ...(r.agent_name ? { agentName: r.agent_name } : {}) });
const op = (r: any): ChainOp => ({ id: r.id, kind: r.kind, challengeId: r.challenge_id === null ? null : Number(r.challenge_id),
  draftId: r.draft_id, payload: r.payload, status: r.status, txHash: r.tx_hash, tries: r.tries, lastError: r.last_error, updatedAt: r.updated_at });
/* eslint-enable @typescript-eslint/no-explicit-any */

export class ChallengeStore {
  constructor(private readonly pool: Pool) {}

  // ---- drafts ----------------------------------------------------------------------------

  async insertDraft(d: Omit<Draft, 'id' | 'createdAt' | 'relayedAt'>): Promise<Draft> {
    const { rows } = await this.pool.query(`insert into challenge_drafts
      (id, creator_wallet, terms, rules_hash, prize_atomic, deadline, salt, auth_nonce) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [randomUUID(), d.creatorWallet.toLowerCase(), JSON.stringify(d.terms), d.rulesHash.toLowerCase(), d.prizeAtomic, d.deadline,
      d.salt.toLowerCase(), d.authNonce.toLowerCase()]);
    return draft(rows[0]);
  }

  async draft(id: string): Promise<Draft | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const { rows } = await this.pool.query('select * from challenge_drafts where id = $1', [id]);
    return rows[0] ? draft(rows[0]) : null;
  }

  async markDraftRelayed(id: string): Promise<void> {
    await this.pool.query('update challenge_drafts set relayed_at = coalesce(relayed_at, now()) where id = $1', [id]);
  }

  // ---- indexed challenges ----------------------------------------------------------------

  async cursor(contract: string): Promise<number | null> {
    const { rows } = await this.pool.query('select next_block from challenge_index_cursor where contract = $1', [contract.toLowerCase()]);
    return rows[0] ? Number(rows[0].next_block) : null;
  }

  async setCursor(contract: string, nextBlock: number): Promise<void> {
    await this.pool.query(`insert into challenge_index_cursor (contract, next_block) values ($1, $2)
      on conflict (contract) do update set next_block = greatest(challenge_index_cursor.next_block, excluded.next_block)`,
    [contract.toLowerCase(), nextBlock]);
  }

  /**
   * Records a ChallengeCreated event once. It is matched to our draft by the authorization nonce
   * (a creation someone else relayed still matches), or else by nothing: then it is unrecognised.
   */
  async recordCreated(contract: string, e: CreatedEvent): Promise<Challenge> {
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      const existing = await db.query('select * from challenges where id = $1', [e.id]);
      if (existing.rows[0]) { await db.query('commit'); return challenge(existing.rows[0]); }
      const zero = /^0x0{64}$/.test(e.authNonce);
      const d = zero ? null : (await db.query(`select * from challenge_drafts where auth_nonce = $1 and creator_wallet = $2
        and rules_hash = $3 and prize_atomic = $4`, [e.authNonce.toLowerCase(), e.creator.toLowerCase(), e.rulesHash.toLowerCase(), e.prizeAtomic])).rows[0];
      const { rows } = await db.query(`insert into challenges (id, contract, draft_id, creator_wallet, terms, rules_hash, prize_atomic,
        deadline, auth_nonce, status, created_tx, created_block) values ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9,$10,$11,$12) returning *`,
      [e.id, contract.toLowerCase(), d?.id ?? null, e.creator.toLowerCase(), d ? JSON.stringify(d.terms) : null, e.rulesHash.toLowerCase(),
        e.prizeAtomic, e.deadline, e.authNonce.toLowerCase(), d ? 'open' : 'unrecognised', e.txHash.toLowerCase(), e.blockNumber]);
      if (d) await db.query('update challenge_drafts set relayed_at = coalesce(relayed_at, now()) where id = $1', [d.id]);
      await db.query('commit');
      return challenge(rows[0]);
    } catch (error) { await db.query('rollback'); throw error; }
    finally { db.release(); }
  }

  async challenge(id: number): Promise<Challenge | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const { rows } = await this.pool.query('select * from challenges where id = $1', [id]);
    return rows[0] ? challenge(rows[0]) : null;
  }

  /** Open challenges first (soonest deadline first), then the most recently settled. */
  async listChallenges(limit = 50): Promise<Challenge[]> {
    const { rows } = await this.pool.query(`select * from challenges where status <> 'unrecognised'
      order by (status = 'open') desc, case when status = 'open' then deadline end asc, id desc limit $1`, [limit]);
    return rows.map(challenge);
  }

  /** Unwon (open, unrecognised, unpaid or refunding) challenges whose deadline and grace have passed. */
  async dueRefunds(now: Date, graceSeconds: number): Promise<Challenge[]> {
    const { rows } = await this.pool.query(`select * from challenges where status in ('open', 'unrecognised', 'unpaid', 'refunding')
      and deadline + make_interval(secs => $2) < $1 order by id`, [now, graceSeconds]);
    return rows.map(challenge);
  }

  async setStatus(id: number, from: ChallengeStatus[], to: ChallengeStatus, settledTx?: Hex): Promise<boolean> {
    const { rowCount } = await this.pool.query(`update challenges set status = $3, settled_tx = coalesce($4, settled_tx)
      where id = $1 and status = any($2)`, [id, from, to, settledTx?.toLowerCase() ?? null]);
    return rowCount === 1;
  }

  // ---- attempts --------------------------------------------------------------------------

  async startAttempt(a: { challengeId: number; agentId: string; animalId: string; payoutWallet: string; startedWorld: number;
    startState: Record<string, unknown> }): Promise<Attempt> {
    const { rows } = await this.pool.query(`insert into challenge_attempts (id, challenge_id, agent_id, animal_id, payout_wallet,
      started_world, start_state, status) values ($1,$2,$3,$4,$5,$6,$7,'running') returning *`,
    [randomUUID(), a.challengeId, a.agentId, a.animalId, a.payoutWallet.toLowerCase(), Math.floor(a.startedWorld), JSON.stringify(a.startState)]);
    return attempt(rows[0]);
  }

  async attempt(id: string): Promise<Attempt | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const { rows } = await this.pool.query('select * from challenge_attempts where id = $1', [id]);
    return rows[0] ? attempt(rows[0]) : null;
  }

  async attemptsOf(challengeId: number): Promise<Attempt[]> {
    const { rows } = await this.pool.query(`select a.*, l.name as agent_name from challenge_attempts a
      left join live_agents l on l.id = a.agent_id where a.challenge_id = $1 order by a.started_at, a.id`, [challengeId]);
    return rows.map(attempt);
  }

  async runningAttempts(): Promise<Attempt[]> {
    const { rows } = await this.pool.query("select * from challenge_attempts where status = 'running' order by started_at");
    return rows.map(attempt);
  }

  async saveProgress(id: string, kills: number, escapes: number): Promise<void> {
    await this.pool.query("update challenge_attempts set kills = $2, escapes = $3 where id = $1 and status = 'running'", [id, kills, escapes]);
  }

  /** Ends a running attempt; false if it had already ended. */
  async endAttempt(id: string, status: 'failed' | 'void', reason: string, endedWorld: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(`update challenge_attempts set status = $2, end_reason = $3, ended_at = now(),
      ended_world = $4 where id = $1 and status = 'running'`, [id, status, reason, Math.floor(endedWorld)]);
    return rowCount === 1;
  }

  /**
   * The first attempt to meet the goal wins: in one transaction the challenge moves from open to
   * won (only one attempt can do that), the attempt is marked met with its result record, the
   * challenge's other running attempts end, and the resolve operation is queued. Returns false
   * if the challenge was no longer open, in which case nothing changes.
   */
  async win(w: { challengeId: number; attemptId: string; endedWorld: number; resultRecord: string; resultHash: Hex;
    winner: string }): Promise<boolean> {
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      const won = await db.query(`update challenges set status = 'won', winner_attempt = $2 where id = $1 and status = 'open'`,
        [w.challengeId, w.attemptId]);
      if (won.rowCount !== 1) { await db.query('rollback'); return false; }
      const met = await db.query(`update challenge_attempts set status = 'met', end_reason = 'goal_met', ended_at = now(),
        ended_world = $2, result_record = $3, result_hash = $4 where id = $1 and status = 'running' and challenge_id = $5`,
      [w.attemptId, Math.floor(w.endedWorld), w.resultRecord, w.resultHash.toLowerCase(), w.challengeId]);
      if (met.rowCount !== 1) { await db.query('rollback'); return false; }
      await db.query(`update challenge_attempts set status = 'void', end_reason = 'challenge_won', ended_at = now(), ended_world = $2
        where challenge_id = $1 and status = 'running'`, [w.challengeId, Math.floor(w.endedWorld)]);
      await db.query(`insert into challenge_chain_ops (id, kind, challenge_id, payload, status) values ($1, 'resolve', $2, $3, 'pending')`,
        [randomUUID(), w.challengeId, JSON.stringify({ winner: w.winner.toLowerCase(), resultHash: w.resultHash.toLowerCase(), attemptId: w.attemptId })]);
      await db.query('commit');
      return true;
    } catch (error) { await db.query('rollback'); throw error; }
    finally { db.release(); }
  }

  /** Ends every running attempt of a challenge (its deadline passed, or it refunded). */
  async endChallengeAttempts(challengeId: number, reason: string, endedWorld: number): Promise<string[]> {
    const { rows } = await this.pool.query(`update challenge_attempts set status = 'failed', end_reason = $2, ended_at = now(),
      ended_world = $3 where challenge_id = $1 and status = 'running' returning id`, [challengeId, reason, Math.floor(endedWorld)]);
    return rows.map((r: { id: string }) => r.id);
  }

  async appendLog(attemptId: string, entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const values: unknown[] = [];
    const tuples = entries.map((e, i) => {
      values.push(attemptId, e.at, e.kind, JSON.stringify(e.data));
      return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
    });
    await this.pool.query(`insert into challenge_attempt_log (attempt_id, at, kind, data) values ${tuples.join(', ')}`, values);
  }

  async log(attemptId: string): Promise<LogEntry[]> {
    const { rows } = await this.pool.query('select at, kind, data from challenge_attempt_log where attempt_id = $1 order by id', [attemptId]);
    return rows.map((r: { at: Date; kind: string; data: Record<string, unknown> }) => ({ at: r.at, kind: r.kind, data: r.data }));
  }

  // ---- chain operations --------------------------------------------------------------------

  /** Queues an operation unless a live one of that kind exists; returns whether it was queued. */
  async enqueueOp(kind: ChainOpKind, target: { challengeId: number } | { draftId: string }, payload: Record<string, unknown>): Promise<boolean> {
    const { rowCount } = await this.pool.query(`insert into challenge_chain_ops (id, kind, challenge_id, draft_id, payload, status)
      values ($1, $2, $3, $4, $5, 'pending') on conflict do nothing`,
    [randomUUID(), kind, 'challengeId' in target ? target.challengeId : null, 'draftId' in target ? target.draftId : null, JSON.stringify(payload)]);
    return rowCount === 1;
  }

  async activeOps(): Promise<ChainOp[]> {
    const { rows } = await this.pool.query(`select * from challenge_chain_ops where status in ('pending', 'sent') order by created_at`);
    return rows.map(op);
  }

  async opsOf(target: { challengeId: number } | { draftId: string }): Promise<ChainOp[]> {
    const { rows } = 'challengeId' in target
      ? await this.pool.query('select * from challenge_chain_ops where challenge_id = $1 order by created_at', [target.challengeId])
      : await this.pool.query('select * from challenge_chain_ops where draft_id = $1 order by created_at', [target.draftId]);
    return rows.map(op);
  }

  /** Records the hash of a transaction about to be broadcast (before the broadcast). */
  async markOpSent(id: string, txHash: Hex): Promise<void> {
    await this.pool.query(`update challenge_chain_ops set status = 'sent', tx_hash = $2, updated_at = now()
      where id = $1 and status in ('pending', 'sent')`, [id, txHash.toLowerCase()]);
  }

  async markOpConfirmed(id: string): Promise<void> {
    await this.pool.query(`update challenge_chain_ops set status = 'confirmed', updated_at = now() where id = $1`, [id]);
  }

  async markOpFailed(id: string, error: string): Promise<void> {
    await this.pool.query(`update challenge_chain_ops set status = 'failed', last_error = $2, updated_at = now() where id = $1`,
      [id, error.slice(0, 500)]);
  }

  /** Back to pending after a dropped transaction or a failed try, counting the try and keeping the reason. */
  async retryOp(id: string, error: string, countTry: boolean): Promise<void> {
    await this.pool.query(`update challenge_chain_ops set status = 'pending', tx_hash = null, last_error = $2,
      tries = tries + $3, updated_at = now() where id = $1`, [id, error.slice(0, 500), countTry ? 1 : 0]);
  }
}
