import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import type { AgentStore } from '../live/liveStore.js';
import type { XUser } from './xAuth.js';

export interface Account { id: string; xUserId: string; handle: string; name: string; xCreatedAt: Date; agentId: string }

export const SESSION_DAYS = 30;
/** An X account younger than this can neither create nor accept a challenge (spec §6). */
export const MIN_X_ACCOUNT_DAYS = 30;
export const CREATES_PER_DAY = 3;
/** Drafts a day, reviewed or not: only sent ones count toward CREATES_PER_DAY, this caps the rest. */
export const DRAFTS_PER_DAY = 20;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
/* eslint-disable @typescript-eslint/no-explicit-any */
const account = (r: any): Account => ({ id: r.id, xUserId: r.x_user_id, handle: r.x_handle, name: r.x_name, xCreatedAt: r.x_created_at, agentId: r.agent_id });
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Who owns an agent for prize payouts: the person whose X account plays it, when that account is at
 * least MIN_X_ACCOUNT_DAYS old (`x:<X user id>`); otherwise null (an outside agent, or a new account).
 */
export async function xOwnerOf(pool: Pool, agentId: string, now = Date.now()): Promise<string | null> {
  const { rows } = await pool.query<{ x_user_id: string; x_created_at: Date }>('select x_user_id, x_created_at from accounts where agent_id = $1', [agentId]);
  const a = rows[0];
  return a && Math.floor((now - a.x_created_at.getTime()) / 86_400_000) >= MIN_X_ACCOUNT_DAYS ? `x:${a.x_user_id}` : null;
}

/** People's accounts and their sessions. Only a session token's hash is ever stored. */
export class AccountStore {
  constructor(private readonly pool: Pool, readonly agents: AgentStore, private readonly clock: () => number = Date.now) {}

  /**
   * Signs a person in: their account (made the first time, with its live identity) and a new session.
   * `networkHash` is the keyed hash of the network they signed in from, kept as their live identity's.
   */
  async signIn(user: XUser, networkHash: string | null = null): Promise<{ account: Account; token: string }> {
    const agent = await this.agents.ensureHuman({ xUserId: user.id, handle: user.username, networkHash: networkHash ?? 'human' });
    const { rows } = await this.pool.query(`insert into accounts (id, x_user_id, x_handle, x_name, x_created_at, agent_id)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (x_user_id) do update set x_handle = excluded.x_handle, x_name = excluded.x_name,
        x_created_at = excluded.x_created_at, signed_in_at = now()
      returning *`, [randomUUID(), user.id, user.username, user.name, user.createdAt, agent.id]);
    // Expired sessions are cleared as people sign in.
    await this.pool.query('delete from account_sessions where expires_at <= $1', [new Date(this.clock())]);
    const token = randomBytes(32).toString('base64url');
    await this.pool.query('insert into account_sessions (token_hash, account_id, expires_at) values ($1, $2, $3)',
      [hash(token), rows[0].id, new Date(this.clock() + SESSION_DAYS * 86_400_000)]);
    return { account: account(rows[0]), token };
  }

  async fromSession(token: string | null): Promise<Account | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const { rows } = await this.pool.query(`select a.* from account_sessions s join accounts a on a.id = s.account_id
      where s.token_hash = $1 and s.expires_at > $2`, [hash(token), new Date(this.clock())]);
    return rows[0] ? account(rows[0]) : null;
  }

  async signOut(token: string | null): Promise<void> {
    if (token) await this.pool.query('delete from account_sessions where token_hash = $1', [hash(token)]);
  }

  /** Challenges the account sent in the last day (relayed, or on their way); drafts only reviewed do not count. */
  async draftsToday(accountId: string): Promise<number> {
    const { rows } = await this.pool.query(`select count(*) filter (where d.relayed_at is not null or exists (select 1 from challenge_chain_ops o
          where o.draft_id = d.id and o.kind = 'relay_create' and o.status <> 'failed'))::int as n from challenge_drafts d
      where d.account_id = $1 and d.created_at > $2`, [accountId, new Date(this.clock() - 86_400_000)]);
    return rows[0].n;
  }

  xAccountDays(a: Account): number { return Math.floor((this.clock() - a.xCreatedAt.getTime()) / 86_400_000); }
}
