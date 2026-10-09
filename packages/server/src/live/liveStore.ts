import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import type { RewardConfig } from '../rewards.js';
import type { Avatar, DropLedger, EndedLife, PlaceDrop } from './liveLayer.js';

/**
 * PostgreSQL for the live layer: registered agents, who is steering which animal, and the
 * place drops in the shared reward ledger (docs/2026-09-26-live-agents-design.md).
 */

/** An outside agent (with its signing key), or a person's own identity in the live world (no key). */
export type AgentKind = 'agent' | 'human';
export interface AgentRecord { id: string; kind: AgentKind; publicKey: string | null; name: string; bio: string; wallet: string | null; walletProven: boolean; muted: boolean }
interface AgentRow { id: string; kind: AgentKind; public_key: string | null; name: string; bio: string; wallet: string | null; wallet_proven: boolean; muted: boolean }
const record = (r: AgentRow): AgentRecord => ({ id: r.id, kind: r.kind, publicKey: r.public_key, name: r.name, bio: r.bio, wallet: r.wallet,
  walletProven: r.wallet_proven, muted: r.muted });

export const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]{1,19}$/;
const RESERVED = /^(admin|vana|system|server|moderator|official|support|staff)/i;
export const agentIdFor = (publicKey: string) => `ag_${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
/** A person's live identity, from their X user id. */
export const humanAgentId = (xUserId: string) => `ag_${createHash('sha256').update(`human:${xUserId}`).digest('hex').slice(0, 16)}`;

export interface LeaderRow { agentId: string; name: string; drops: number; usdcMicro: string; longestLifeSeconds: number; animalsLost: number; playing: boolean }
export interface RegistrationLimits { slots: number; perNetworkPerDay: number }

export class AgentStore {
  readonly #byKey = new Map<string, AgentRecord>();
  /** When this process last wrote each agent's last_seen_at. */
  readonly #touched = new Map<string, number>();
  constructor(private readonly pool: Pool) {}

  async byKey(publicKey: string): Promise<AgentRecord | null> {
    const cached = this.#byKey.get(publicKey);
    if (cached) return cached;
    const row = (await this.pool.query<AgentRow>("select * from live_agents where public_key=$1 and kind = 'agent'", [publicKey])).rows[0];
    if (!row) return null;
    const agent = record(row);
    if (this.#byKey.size > 5000) this.#byKey.clear();
    this.#byKey.set(publicKey, agent);
    return agent;
  }

  async byId(id: string): Promise<AgentRecord | null> {
    const row = (await this.pool.query<AgentRow>('select * from live_agents where id=$1', [id])).rows[0];
    return row ? record(row) : null;
  }

  /** One agent per key and name; at most `slots` agents; a few new ones per network a day. */
  /** Registers a key. `wallet`, when given, is already proven (the holding gate) and becomes its payout wallet. */
  async register(p: { publicKey: string; name: string; bio: string; networkHash: string; wallet?: string }, limits: RegistrationLimits):
    Promise<{ ok: true; agent: AgentRecord; created: boolean } | { ok: false; reason: string }> {
    const existing = await this.byKey(p.publicKey);
    if (existing) return { ok: true, agent: existing, created: false };
    if (!NAME_RE.test(p.name) || RESERVED.test(p.name)) return { ok: false, reason: 'bad_name' };
    const bio = p.bio.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      await db.query("select pg_advisory_xact_lock(hashtext('live-agent-registration'))");
      const counts = (await db.query<{ total: number; network: number }>(`select count(*)::int as total,
        count(*) filter (where network_hash=$1 and created_at > now() - interval '24 hours')::int as network from live_agents
        where kind = 'agent'`, [p.networkHash])).rows[0]!;
      if (counts.total >= limits.slots) { await db.query('rollback'); return { ok: false, reason: 'slots_full' }; }
      if (counts.network >= limits.perNetworkPerDay) { await db.query('rollback'); return { ok: false, reason: 'network_daily_limit' }; }
      if (p.wallet && (await db.query('select 1 from live_agents where wallet=$1', [p.wallet])).rowCount) { await db.query('rollback'); return { ok: false, reason: 'wallet_taken' }; }
      const inserted = await db.query<AgentRow>(`insert into live_agents(id, public_key, name, name_key, bio, network_hash, wallet, wallet_proven)
        values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning *`,
      [agentIdFor(p.publicKey), p.publicKey, p.name, p.name.toLowerCase(), bio, p.networkHash, p.wallet ?? null, !!p.wallet]);
      if (!inserted.rowCount) { await db.query('rollback'); return { ok: false, reason: 'name_taken' }; }
      await db.query('commit');
      return { ok: true, agent: record(inserted.rows[0]!), created: true };
    } catch (error) { await db.query('rollback'); throw error; }
    finally { db.release(); }
  }

  /**
   * A person's own identity in the live world, made the first time they sign in. Its name is
   * their X handle where that is a valid, free live name; otherwise "X <handle>", then a number.
   */
  async ensureHuman(p: { xUserId: string; handle: string; networkHash: string }): Promise<AgentRecord> {
    const id = humanAgentId(p.xUserId);
    const existing = await this.byId(id);
    if (existing && existing.kind !== 'human') throw new Error('identity clash');
    if (existing) return existing;
    const handle = p.handle.replace(/[^A-Za-z0-9_]/g, '').slice(0, 15) || 'player';
    const base = NAME_RE.test(handle) && !RESERVED.test(handle) ? handle : `X ${handle}`;
    for (const name of [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base} ${n}`), `${base} ${id.slice(3, 7)}`]) {
      const inserted = await this.pool.query<AgentRow>(`insert into live_agents (id, kind, public_key, name, name_key, network_hash, wallet_proven)
        values ($1, 'human', null, $2, $3, $4, false) on conflict do nothing returning *`, [id, name, name.toLowerCase(), p.networkHash]);
      if (inserted.rowCount) return record(inserted.rows[0]!);
      const raced = await this.byId(id);
      if (raced) return raced;
    }
    throw new Error('no free name for this player');
  }

  /** Sets a proven payout wallet. One agent per wallet, checked on every change. */
  async setWallet(agentId: string, wallet: string): Promise<'ok' | 'wallet_taken'> {
    let changed: boolean;
    try {
      changed = !!(await this.pool.query(`update live_agents set wallet=$2, wallet_proven=true where id=$1
        and not exists (select 1 from live_agents where wallet=$2 and id<>$1)`, [agentId, wallet])).rowCount;
    } catch (error) {
      // Two agents claiming one wallet at the same moment: the unique index picks the first.
      if ((error as { code?: string }).code !== '23505') throw error;
      changed = false;
    }
    for (const [key, agent] of this.#byKey) if (agent.id === agentId) this.#byKey.delete(key);
    return changed ? 'ok' : 'wallet_taken';
  }

  /**
   * Marks an agent seen, for the 14-day reaping. Called on every signed request, so the write is
   * skipped when this process wrote it in the last minute: a query per call kept the pool full
   * at 250 agents (load test, 5 October 2026). A failed write is retried on the next call.
   */
  async touch(agentId: string, now = Date.now()): Promise<void> {
    const last = this.#touched.get(agentId);
    if (last !== undefined && now - last < 60_000) return;
    if (this.#touched.size > 20_000) this.#touched.clear();
    this.#touched.set(agentId, now);
    try {
      await this.pool.query("update live_agents set last_seen_at=now() where id=$1 and last_seen_at < now() - interval '1 minute'", [agentId]);
    } catch (error) { this.#touched.delete(agentId); throw error; }
  }

  async list(): Promise<Array<{ id: string; name: string; bio: string }>> {
    return (await this.pool.query<{ id: string; name: string; bio: string }>('select id, name, bio from live_agents order by created_at')).rows;
  }

  /** Silences (or lets speak again) an agent, found by id or name. Returns its id, or null if there is none. */
  async setMuted(idOrName: string, muted: boolean): Promise<string | null> {
    const row = (await this.pool.query<{ id: string }>('update live_agents set muted=$2 where id=$1 or name_key=lower($1) returning id',
      [idOrName.trim(), muted])).rows[0];
    this.#byKey.clear();
    return row?.id ?? null;
  }

  /** Registered agents, each holding one of the slots (people's own identities do not). */
  async count(): Promise<number> {
    return Number((await this.pool.query<{ n: string }>("select count(*) as n from live_agents where kind = 'agent'")).rows[0]!.n);
  }

  /** One finished possession. */
  async recordLife(life: EndedLife): Promise<void> {
    await this.pool.query(`insert into live_lives (agent_id, animal_id, species_id, started_at, ended_at, how)
      values ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), $6)`,
    [life.agentId, life.animalId, life.speciesId, life.since, Math.max(life.since, life.endedAt), life.how]);
  }

  /**
   * Agents ranked by drops won (then USDC won, then their longest life with one animal). A life
   * still going counts from when it began. Agents with nothing yet are left out.
   */
  async leaderboard(playing: Iterable<{ agentId: string; since: number }>, now: number, limit = 50): Promise<LeaderRow[]> {
    const { rows } = await this.pool.query<{ id: string; name: string; drops: string; usdc_micro: string; best_s: string | null; lost: string }>(`
      with lives as (
        select agent_id, max(extract(epoch from ended_at - started_at)) as best_s,
          count(*) filter (where how in ('died', 'caught')) as lost
        from live_lives group by agent_id),
      wins as (
        select c.agent_id, count(*) as drops, sum(d.amount_micro) as usdc_micro
        from reward_claims c join reward_drops d on d.id = c.drop_id
        where c.agent_id is not null and c.status in ('reserved', 'paid_reported') group by c.agent_id)
      select a.id, a.name, coalesce(w.drops, 0) as drops, coalesce(w.usdc_micro, 0) as usdc_micro,
        l.best_s, coalesce(l.lost, 0) as lost
      from live_agents a left join wins w on w.agent_id = a.id left join lives l on l.agent_id = a.id`);
    const current = new Map<string, number>();
    for (const p of playing) current.set(p.agentId, Math.max(0, (now - p.since) / 1000));
    return rows.map((r) => ({ agentId: r.id, name: r.name, drops: Number(r.drops), usdcMicro: r.usdc_micro,
      longestLifeSeconds: Math.round(Math.max(Number(r.best_s ?? 0), current.get(r.id) ?? 0)), animalsLost: Number(r.lost),
      playing: current.has(r.id) }))
      .filter((r) => r.drops > 0 || r.longestLifeSeconds > 0 || r.playing)
      .sort((a, b) => b.drops - a.drops || Number(BigInt(b.usdcMicro) - BigInt(a.usdcMicro)) || b.longestLifeSeconds - a.longestLifeSeconds || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  /** Frees the slot of an agent unseen for `days`, so slots cannot be squatted forever. */
  async reapInactive(days = 14): Promise<number> {
    // An agent that has played a challenge is kept: its attempts, logs and on-chain records refer to it.
    const result = await this.pool.query(`delete from live_agents where kind = 'agent' and last_seen_at < now() - make_interval(days => $1)
      and id not in (select agent_id from live_possessions) and id not in (select agent_id from challenge_attempts)`, [days]);
    this.#byKey.clear();
    return result.rowCount ?? 0;
  }

  async savePossessions(worldId: string, avatars: Iterable<Avatar>): Promise<void> {
    const list = [...avatars];
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      await db.query('delete from live_possessions where not (agent_id = any($1::text[]))', [list.map((a) => a.agentId)]);
      for (const a of list) {
        await db.query(`insert into live_possessions(agent_id, animal_id, world_id, started_at, x, z, heading, last_command_at)
          values ($1,$2,$3,to_timestamp($4/1000.0),$5,$6,$7,to_timestamp($8/1000.0))
          on conflict (agent_id) do update set animal_id=excluded.animal_id, world_id=excluded.world_id, started_at=excluded.started_at,
            x=excluded.x, z=excluded.z, heading=excluded.heading, last_command_at=excluded.last_command_at`,
          [a.agentId, a.animalId, worldId, a.since, a.x, a.z, a.heading, a.lastCommand]);
      }
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    finally { db.release(); }
  }

  async loadPossessions(worldId: string): Promise<Array<{ agentId: string; agentName: string; animalId: string; x: number; z: number; heading: number; since: number; lastCommand: number }>> {
    const { rows } = await this.pool.query<{ agent_id: string; name: string; animal_id: string; x: number; z: number; heading: number; since: number; last_command: number }>(
      `select p.agent_id, a.name, p.animal_id, p.x, p.z, p.heading, extract(epoch from p.started_at) * 1000 as since,
         extract(epoch from p.last_command_at) * 1000 as last_command
       from live_possessions p join live_agents a on a.id = p.agent_id where p.world_id=$1`, [worldId]);
    return rows.map((r) => ({ agentId: r.agent_id, agentName: r.name, animalId: r.animal_id, x: r.x, z: r.z, heading: r.heading,
      since: Number(r.since), lastCommand: Number(r.last_command) }));
  }
}

// ---- Place drops ----------------------------------------------------------------------------

export const HINT_RADIUS_M = 40;
export const CLAIM_COOLDOWN_MINUTES = 10;
export const MIN_POSSESSED_MINUTES = 5;

interface PlaceRow { id: string; amount_micro: string; place_x: number; place_z: number; hint_x: number; hint_z: number;
  expires_at: Date; spotted_by: string | null }

/** Deterministic drop ids from a batch id, so a retried admin request cannot double a batch. */
function dropId(batchId: string, index: number): string {
  const h = createHash('sha256').update(`place-drop:${batchId}:${index}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class PlaceDropLedger implements DropLedger {
  #active: PlaceDrop[] = [];

  constructor(private readonly pool: Pool, private readonly config: RewardConfig, private readonly worldId: () => string | null,
    private readonly agents: AgentStore) {}

  active(): PlaceDrop[] { return this.#active; }

  /** Reloads the drops that have appeared and not expired; expired unclaimed ones are closed. */
  async refresh(): Promise<void> {
    const world = this.worldId();
    if (world === null) { this.#active = []; return; }
    const expired = await this.pool.query<{ id: string }>(`update reward_drops set status='cancelled'
      where kind='place' and status='open' and expires_at <= now() returning id`);
    for (const row of expired.rows) {
      await this.pool.query("insert into reward_audit(drop_id,action,network,note) values ($1,'expired',$2,'Place drop expired unclaimed')", [row.id, this.config.network]);
    }
    const { rows } = await this.pool.query<PlaceRow>(`select id, amount_micro::text, place_x, place_z, hint_x, hint_z, expires_at, spotted_by
      from reward_drops where kind='place' and status='open' and world_id=$1 and network=$2 and appears_at <= now() and expires_at > now()
      order by appears_at`, [world, this.config.network]);
    this.#active = rows.map((r) => ({ id: r.id, amountMicro: r.amount_micro, x: r.place_x, z: r.place_z, hintX: r.hint_x, hintZ: r.hint_z,
      hintRadius: HINT_RADIUS_M, expiresAt: r.expires_at.getTime(), spottedBy: r.spotted_by }));
  }

  spot(id: string, agentId: string): void {
    const drop = this.#active.find((d) => d.id === id);
    if (drop && !drop.spottedBy) drop.spottedBy = agentId;
    void this.pool.query('update reward_drops set spotted_by=$2, spotted_at=now() where id=$1 and spotted_by is null', [id, agentId]).catch(() => undefined);
  }

  /** Why this agent may not open a drop right now, or null. Checked before the open starts. */
  async blocker(agentId: string, possessedSince: number): Promise<string | null> {
    if (Date.now() - possessedSince < MIN_POSSESSED_MINUTES * 60_000) return 'possess_longer_first';
    const agent = await this.agents.byId(agentId);
    if (!agent?.wallet || !agent.walletProven) return 'prove_wallet_first';
    const { rows } = await this.pool.query<{ recent: number; wallet: number }>(`select
      count(*) filter (where agent_id=$1 and created_at > now() - make_interval(mins => $3))::int as recent,
      count(*) filter (where wallet=$2 and created_at > now() - interval '24 hours')::int as wallet
      from reward_claims where status in ('reserved','paid_reported','verified_paid') and (agent_id=$1 or wallet=$2)`,
    [agentId, agent.wallet, CLAIM_COOLDOWN_MINUTES]);
    if (rows[0]!.recent > 0) return 'cooldown';
    if (this.config.walletDailyLimit !== undefined && rows[0]!.wallet >= this.config.walletDailyLimit) return 'wallet_daily_limit';
    return null;
  }

  /** The first finished open reserves the drop for the agent's proven wallet. */
  async claim(id: string, agentId: string): Promise<{ ok: true; claimId: string } | { ok: false; reason: string }> {
    const agent = await this.agents.byId(agentId);
    if (!agent?.wallet || !agent.walletProven) return { ok: false, reason: 'prove_wallet_first' };
    const world = this.worldId();
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      await db.query("select pg_advisory_xact_lock(hashtext('reward-wallet:' || $1))", [agent.wallet]);
      const drop = (await db.query<{ status: string; world_id: string; expires_at: Date; network: string }>(
        "select status, world_id, expires_at, network from reward_drops where id=$1 and kind='place' for update", [id])).rows[0];
      if (!drop || drop.world_id !== world || drop.network !== this.config.network) { await db.query('rollback'); return { ok: false, reason: 'no_such_drop' }; }
      if (drop.status !== 'open' || drop.expires_at.getTime() <= Date.now()) { await db.query('rollback'); return { ok: false, reason: 'taken' }; }
      // The same limits as before the open, again under the wallet lock, so two opens cannot race past them.
      const limits = (await db.query<{ recent: number; wallet: number }>(`select
        count(*) filter (where agent_id=$1 and created_at > now() - make_interval(mins => $3))::int as recent,
        count(*) filter (where wallet=$2 and created_at > now() - interval '24 hours')::int as wallet
        from reward_claims where status in ('reserved','paid_reported','verified_paid') and (agent_id=$1 or wallet=$2)`,
      [agentId, agent.wallet, CLAIM_COOLDOWN_MINUTES])).rows[0]!;
      if (limits.recent > 0) { await db.query('rollback'); return { ok: false, reason: 'cooldown' }; }
      if (this.config.walletDailyLimit !== undefined && limits.wallet >= this.config.walletDailyLimit) {
        await db.query('rollback'); return { ok: false, reason: 'wallet_daily_limit' };
      }
      const claimId = randomUUID();
      await db.query(`insert into reward_claims(id, drop_id, observer_hash, wallet, agent_id) values ($1,$2,$3,$4,$5)`,
        [claimId, id, `agent:${agentId}`, agent.wallet, agentId]);
      await db.query("update reward_drops set status='reserved' where id=$1", [id]);
      await db.query("insert into reward_audit(drop_id,claim_id,action,network,note) values ($1,$2,'claim_submitted',$3,$4)",
        [id, claimId, this.config.network, `Opened by agent ${agent.name} (${agentId})`]);
      await db.query('commit');
      this.#active = this.#active.filter((d) => d.id !== id);
      return { ok: true, claimId };
    } catch (error) { await db.query('rollback'); throw error; }
    finally { db.release(); }
  }

  /** An admin batch: `count` drops of `amountMicro`, appearing `spacingMinutes` apart at random land spots. */
  async createBatch(p: { batchId: string; amountMicro: string; count: number; spacingMinutes: number; lifetimeMinutes: number },
    spot: () => { x: number; z: number } | null, random: () => number = Math.random): Promise<{ created: number; ids: string[] }> {
    const world = this.worldId();
    if (world === null) throw new Error('world_unavailable');
    const ids: string[] = [];
    let created = 0;
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      for (let i = 0; i < p.count; i++) {
        const id = dropId(p.batchId, i);
        ids.push(id);
        const at = spot();
        if (!at) throw new Error('no_land_spot');
        // The hint circle contains the drop but is not centred on it.
        const angle = random() * Math.PI * 2, offset = HINT_RADIUS_M * (0.25 + random() * 0.6);
        const result = await db.query(`insert into reward_drops(id, actor_id, network, amount_micro, reveal_when, world_id, kind,
            place_x, place_z, hint_x, hint_z, appears_at, expires_at)
          values ($1, null, $2, $3, 'place', $4, 'place', $5, $6, $7, $8,
            now() + make_interval(mins => $9), now() + make_interval(mins => $9 + $10))
          on conflict (id) do nothing`,
        [id, this.config.network, p.amountMicro, world, at.x, at.z, at.x + Math.sin(angle) * offset, at.z + Math.cos(angle) * offset,
          i * p.spacingMinutes, p.lifetimeMinutes]);
        if (result.rowCount) {
          created++;
          await db.query("insert into reward_audit(drop_id,action,network,note) values ($1,'allocated',$2,$3)",
            [id, this.config.network, `Place drop ${i + 1} of ${p.count} in batch ${p.batchId}`]);
        }
      }
      await db.query('commit');
      return { created, ids };
    } catch (error) { await db.query('rollback'); throw error; }
    finally { db.release(); }
  }
}
