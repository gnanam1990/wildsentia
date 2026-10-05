import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { PlaceDropLedger } from './live/liveStore.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from './db/pool.js';
import { baseReceiptRpc, matchBaseUsdcReceipt, type ReceiptRpc } from './baseReceipt.js';

export type RewardNetwork = 'base';
export interface RewardConfig {
  adminToken: string; network: 'base'; claimPolicy: 'first_valid'; receiptRpcUrl?: string; payoutWallet?: string;
  /** Seconds an observer must have been watching the subject before a claim is accepted. */
  minWatchSeconds?: number;
  /** Winning claims one wallet may hold in any 24 hours. */
  walletDailyLimit?: number;
  /**
   * Winning claims one network address may make in any 24 hours. Off unless set: mobile
   * carriers put many people behind one address, so a low cap would lock out a whole area.
   */
  clientDailyLimit?: number;
}
/** Anti-abuse defaults for a configured server. A config built directly (tests) leaves them off. */
export const REWARD_LIMIT_DEFAULTS = { minWatchSeconds: 60, walletDailyLimit: 5 } as const;
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!/^[0-9]+$/.test(value) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
export function rewardConfig(env: NodeJS.ProcessEnv): RewardConfig | undefined {
  // No financial/network/winner-policy default. All three are an explicit operator choice.
  if (!env.VANA_REWARD_ADMIN_TOKEN && !env.VANA_REWARD_NETWORK && !env.VANA_REWARD_POLICY
    && !env.VANA_REWARD_RECEIPT_RPC_URL && !env.VANA_REWARD_PAYOUT_WALLET) return;
  if ((env.VANA_REWARD_ADMIN_TOKEN?.length ?? 0) < 32
    || (env.VANA_REWARD_ADMIN_TOKEN?.length ?? 0) > 256
    || /\s/.test(env.VANA_REWARD_ADMIN_TOKEN ?? '')
    || env.VANA_REWARD_NETWORK !== 'base'
    || env.VANA_REWARD_POLICY !== 'first_valid') throw new Error('Invalid explicit reward configuration');
  if (!!env.VANA_REWARD_RECEIPT_RPC_URL !== !!env.VANA_REWARD_PAYOUT_WALLET) throw new Error('Incomplete reward receipt configuration');
  if (env.VANA_REWARD_RECEIPT_RPC_URL) {
    const rpc = new URL(env.VANA_REWARD_RECEIPT_RPC_URL);
    if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.hash || !walletAddress(env.VANA_REWARD_PAYOUT_WALLET, 'base'))
      throw new Error('Invalid reward receipt configuration');
  }
  return { adminToken: env.VANA_REWARD_ADMIN_TOKEN!, network: 'base', claimPolicy: 'first_valid',
    minWatchSeconds: boundedInteger(env.VANA_REWARD_MIN_WATCH_SECONDS, REWARD_LIMIT_DEFAULTS.minWatchSeconds, 0, 3600, 'VANA_REWARD_MIN_WATCH_SECONDS'),
    walletDailyLimit: boundedInteger(env.VANA_REWARD_WALLET_DAILY_LIMIT, REWARD_LIMIT_DEFAULTS.walletDailyLimit, 1, 100, 'VANA_REWARD_WALLET_DAILY_LIMIT'),
    ...(env.VANA_REWARD_CLIENT_DAILY_LIMIT
      ? { clientDailyLimit: boundedInteger(env.VANA_REWARD_CLIENT_DAILY_LIMIT, 0, 1, 1000, 'VANA_REWARD_CLIENT_DAILY_LIMIT') } : {}),
    ...(env.VANA_REWARD_RECEIPT_RPC_URL ? { receiptRpcUrl: env.VANA_REWARD_RECEIPT_RPC_URL,
      payoutWallet: walletAddress(env.VANA_REWARD_PAYOUT_WALLET, 'base')! } : {}) };
}
export function microAmount(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return amount > 0n && amount <= 1_000_000_000_000n ? amount.toString() : null;
}
export function displayAmount(value: string): string {
  const n = BigInt(value); return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, '0')}`;
}
/** Syntax + EIP-55 for mixed case. Not proof of ownership or USDC receive capability. */
export function walletAddress(value: unknown, network: RewardNetwork): string | null {
  if (network !== 'base' || typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) return null;
  const plain = value.slice(2), lower = plain.toLowerCase();
  if (plain !== lower && plain !== plain.toUpperCase()) {
    const digest = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString('hex');
    const checked = [...lower].map((c, i) => parseInt(digest[i]!, 16) >= 8 ? c.toUpperCase() : c).join('');
    if (plain !== checked) return null;
  }
  return `0x${lower}`;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const bodyOf = (request: FastifyRequest): Record<string, unknown> =>
  typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
    ? request.body as Record<string, unknown> : {};
const bearer = (r: FastifyRequest): string => r.headers.authorization?.match(/^Bearer ([^\s]{1,256})$/)?.[1] ?? '';
interface Drop { id: string; actor_id: string; amount_micro: string; network: RewardNetwork; reveal_when: string; status: string; world_id?: string | null;
  kind?: 'animal' | 'place'; place_x?: number | null; place_z?: number | null; appears_at?: Date | null; expires_at?: Date | null; spotted_by?: string | null }
interface ReservedPayout { amount_micro: string; wallet: string; drop_status: string; claim_status: string }
interface StoredPayout { claim_id: string; tx_hash: string; log_index: number; block_number: string; block_hash: string }
const publicDrop = (d: Drop) => ({ id: d.id, actorId: d.actor_id, amount: displayAmount(d.amount_micro), network: d.network,
  status: d.status, revealWhen: d.reveal_when, kind: d.kind ?? 'animal',
  ...(d.kind === 'place' ? { place: { x: d.place_x, z: d.place_z }, appearsAt: d.appears_at ?? null, expiresAt: d.expires_at ?? null,
    spottedBy: d.spotted_by ?? null } : {}) });
type PageKind = 'drops' | 'claims' | 'audit';
type PageRow = { id: string; cursor_time?: string } & Record<string, unknown>;
const PAGE_SIZE = 100;
const utcCursorTime = `to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function encodeCursor(kind: PageKind, row: PageRow): string {
  return Buffer.from(JSON.stringify(kind === 'audit' ? { kind, id: row.id } : { kind, t: row.cursor_time, id: row.id })).toString('base64url');
}
function decodeCursor(kind: PageKind, value: unknown): { t?: string; id: string } | null {
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object') return null;
    const { kind: decodedKind, t, id } = decoded as { kind?: unknown; t?: unknown; id?: unknown };
    if (decodedKind !== kind) return null;
    if (kind === 'audit') return typeof id === 'string' && /^[1-9][0-9]{0,18}$/.test(id) ? { id } : null;
    return uuid(id) && typeof t === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(t)
      && Number.isFinite(Date.parse(t)) ? { t, id } : null;
  } catch { return null; }
}

export function installRewards(app: FastifyInstance, deps: {
  pool: Pool; config?: RewardConfig | undefined;
  receiptRpc?: ReceiptRpc;
  /** Read-only visibility adapter; reward code receives no simulation object or mutation capability. */
  subject: (id: string) => { alive: boolean; carcass: boolean } | null;
  /** The running world's durable identity, or null before it is known. Rewards fail closed without it. */
  world?: () => string | null;
  /** Place drops opened by live agents (docs/2026-09-26-live-agents-design.md), when enabled. */
  placeDrops?: { ledger: PlaceDropLedger; spot: () => { x: number; z: number } | null };
  /** Silencing a live agent's chat (it keeps playing). */
  agents?: { mute(idOrName: string, muted: boolean): Promise<string | null> };
}): void {
  const { pool, config, subject } = deps;
  const minWatchSeconds = config?.minWatchSeconds ?? 0;
  // A drop belongs to the world it was allocated in. Drops from before world identities
  // existed are bound, once, to the world this ledger is running with.
  let boundWorld: string | null = null;
  async function currentWorld(): Promise<string | null> {
    const id = deps.world?.() ?? null;
    if (id === null) return null;
    if (boundWorld !== id) {
      await pool.query('update reward_drops set world_id=$1 where world_id is null', [id]);
      boundWorld = id;
    }
    return id;
  }
  /** A receipt lets a claimant check their own claim later. Derived, so a retried claim gets the same one. */
  const receiptKey = hash(`claim-receipt:${config?.adminToken ?? ''}`);
  const receiptFor = (claimId: string): string => createHmac('sha256', receiptKey).update(claimId).digest('hex');
  const clientHash = (req: FastifyRequest): string => hash(`claim-client:${config?.adminToken ?? ''}:${req.ip}`);
  const receiptRpc = deps.receiptRpc ?? (config?.receiptRpcUrl ? baseReceiptRpc(config.receiptRpcUrl) : undefined);
  const limits = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', async (req, reply) => {
    // The route the request was dispatched to, not its raw URL: the router decodes
    // percent-escapes, so "/%61dmin/rewards" reaches /admin/rewards too.
    const route = req.routeOptions.url ?? '';
    if (!/^\/(rewards|admin\/rewards)(\/|$)/.test(route)) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    if (req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'same_origin_required' });
    if (!config) return reply.code(503).send({ error: 'rewards_not_configured' });
    const now = Date.now();
    for (const [key, value] of limits) if (value.until < now) limits.delete(key);
    const key = req.ip;
    const window = limits.get(key) ?? { count: 0, until: now + 60_000 };
    if (!limits.has(key) && limits.size >= 5000 || ++window.count > 120) return reply.code(429).send({ error: 'rate_limited' });
    limits.set(key, window);
    // Count rejected admin attempts too; otherwise guesses bypass the per-IP limit.
    if (route.startsWith('/admin/')) {
      const actual = Buffer.from(hash(bearer(req))), expected = Buffer.from(hash(config.adminToken));
      if (!timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'admin_auth_required' });
    }
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json'))
      return reply.code(415).send({ error: 'json_required' });
  });

  async function observer(req: FastifyRequest): Promise<{ token_hash: string; actor_id: string | null } | null> {
    if (!/^[0-9a-f]{64}$/.test(bearer(req))) return null;
    const result = await pool.query<{ token_hash: string; actor_id: string | null }>(
      'select token_hash, actor_id from reward_observers where token_hash=$1 and expires_at > now()', [hash(bearer(req))]);
    return result.rows[0] ?? null;
  }
  const visible = (d: Drop): boolean => {
    const animal = subject(d.actor_id);
    return !!animal && (d.reveal_when === 'carcass' ? animal.carcass : animal.alive || animal.carcass);
  };

  app.get('/rewards/summary', async (_req, reply) => {
    const world = await currentWorld();
    if (world === null) return reply.code(503).send({ error: 'world_unavailable' });
    const { rows } = await pool.query<{ status: string; amount: string }>(
      'select status, sum(amount_micro)::text as amount from reward_drops where network=$1 and world_id=$2 group by status', [config!.network, world]);
    const amount = (status: string) => displayAmount(rows.find((r) => r.status === status)?.amount ?? '0');
    return { network: config!.network, policy: config!.claimPolicy, available: amount('open'), reserved: amount('reserved'),
      paidReported: amount('paid_reported'), verifiedPaid: amount('verified_paid'), fundingVerified: false,
      notice: 'Admin allocations, not a verified treasury balance. First accepted claim reserves; payment is manual. Verified paid means an exact finalized Base USDC transfer was recorded, not that the treasury balance was audited.' };
  });

  app.post('/rewards/session', async () => {
    const token = randomBytes(32).toString('hex');
    await pool.query('delete from reward_observers where expires_at <= now()');
    await pool.query("insert into reward_observers(token_hash, expires_at) values ($1, now()+interval '1 hour')", [hash(token)]);
    return { token };
  });
  app.post('/rewards/watch', { bodyLimit: 1024 }, async (req, reply) => {
    const viewer = await observer(req); if (!viewer) return reply.code(401).send({ error: 'observer_session_required' });
    const actorId = bodyOf(req).actorId;
    if (actorId !== null && (typeof actorId !== 'string' || actorId.length > 128 || !subject(actorId)))
      return reply.code(400).send({ error: 'unknown_subject' });
    const world = await currentWorld();
    if (world === null) return reply.code(503).send({ error: 'world_unavailable' });
    // Watching time restarts only when the subject changes; re-sending the same one keeps it.
    const watched = (await pool.query<{ seconds: number }>(`update reward_observers
      set watch_started_at = case when actor_id is not distinct from $1 and watch_started_at is not null
        then watch_started_at else now() end, actor_id=$1
      where token_hash=$2 returning extract(epoch from now() - watch_started_at)::float8 as seconds`,
    [actorId, viewer.token_hash])).rows[0]?.seconds ?? 0;
    if (actorId === null) return { drops: [] };
    const { rows } = await pool.query<Drop>(
      "select * from reward_drops where actor_id=$1 and network=$2 and world_id=$3 and status='open' order by created_at limit 20",
      [actorId, config!.network, world]);
    return { drops: rows.filter(visible).map(publicDrop), claimableInSeconds: Math.max(0, Math.ceil(minWatchSeconds - watched)) };
  });
  app.post('/rewards/claims', { bodyLimit: 2048 }, async (req, reply) => {
    const viewer = await observer(req); if (!viewer) return reply.code(401).send({ error: 'observer_session_required' });
    const body = bodyOf(req), wallet = walletAddress(body.wallet, config!.network);
    if (!uuid(body.dropId) || !wallet) return reply.code(400).send({ error: 'invalid_claim_or_wallet' });
    const db = await pool.connect();
    try {
      await db.query('begin');
      const world = await currentWorld();
      if (world === null) { await db.query('rollback'); return reply.code(503).send({ error: 'world_unavailable' }); }
      const currentViewer = (await db.query<{ actor_id: string | null; watched: number | null }>(
        `select actor_id, extract(epoch from now() - watch_started_at)::float8 as watched from reward_observers
         where token_hash=$1 and expires_at > now() for share`, [viewer.token_hash])).rows[0];
      if (!currentViewer) { await db.query('rollback'); return reply.code(401).send({ error: 'observer_session_required' }); }
      const drop = (await db.query<Drop>('select * from reward_drops where id=$1 for update', [body.dropId])).rows[0];
      // Repeated submit returns the same receipt, including after reservation. Never edits the wallet.
      const previous = (await db.query<{ id: string; wallet: string; status: string }>(
        'select id, wallet, status from reward_claims where drop_id=$1 and observer_hash=$2', [body.dropId, viewer.token_hash])).rows[0];
      if (previous && drop) {
        await db.query('rollback');
        if (previous.wallet !== wallet) return reply.code(409).send({ error: 'claim_wallet_immutable' });
        return { claimId: previous.id, status: previous.status, amount: displayAmount(drop.amount_micro), network: drop.network,
          receipt: receiptFor(previous.id) };
      }
      if (!drop || drop.kind === 'place' || drop.network !== config!.network || drop.world_id !== world
        || currentViewer.actor_id !== drop.actor_id || !visible(drop)) {
        await db.query('rollback'); return reply.code(404).send({ error: 'watch_subject_to_claim' });
      }
      if (drop.status !== 'open') { await db.query('rollback'); return reply.code(409).send({ error: 'reward_unavailable' }); }
      // Anti-abuse. Anonymous watching cannot prove a person, but it can cost real time, and
      // wins per wallet and per network address are capped. Locks make the counts race-free.
      const remaining = Math.ceil(minWatchSeconds - (currentViewer.watched ?? 0));
      if (remaining > 0) { await db.query('rollback'); return reply.code(425).send({ error: 'keep_watching', retryAfterSeconds: remaining }); }
      const client = clientHash(req);
      await db.query("select pg_advisory_xact_lock(hashtext('reward-wallet:' || $1))", [wallet]);
      await db.query("select pg_advisory_xact_lock(hashtext('reward-client:' || $1))", [client]);
      const recent = (column: 'wallet' | 'client_hash', value: string) => db.query<{ n: number }>(
        `select count(*)::int as n from reward_claims where ${column}=$1
         and status in ('reserved','paid_reported','verified_paid') and created_at > now() - interval '24 hours'`, [value]);
      if (config!.walletDailyLimit !== undefined && (await recent('wallet', wallet)).rows[0]!.n >= config!.walletDailyLimit) {
        await db.query('rollback'); return reply.code(429).send({ error: 'wallet_daily_limit' });
      }
      if (config!.clientDailyLimit !== undefined && (await recent('client_hash', client)).rows[0]!.n >= config!.clientDailyLimit) {
        await db.query('rollback'); return reply.code(429).send({ error: 'client_daily_limit' });
      }
      const id = randomUUID();
      const result = await db.query(`insert into reward_claims(id,drop_id,observer_hash,wallet,client_hash) values ($1,$2,$3,$4,$5)
        on conflict do nothing returning id`, [id, drop.id, viewer.token_hash, wallet, client]);
      if (!result.rowCount) { await db.query('rollback'); return reply.code(409).send({ error: 'wallet_already_submitted' }); }
      await db.query("update reward_drops set status='reserved' where id=$1", [drop.id]);
      await db.query("insert into reward_audit(drop_id,claim_id,action,network) values ($1,$2,'claim_submitted',$3)", [drop.id, id, drop.network]);
      await db.query('commit');
      return { claimId: id, status: 'reserved', amount: displayAmount(drop.amount_micro), network: drop.network, receipt: receiptFor(id) };
    } catch { await db.query('rollback'); return reply.code(503).send({ error: 'claim_unavailable_retry_same_details' }); }
    finally { db.release(); }
  });

  // A claimant's own status, by claim ID and the receipt the claim returned. The same 404 for an
  // unknown claim and a wrong receipt, so neither claim IDs nor receipts can be probed.
  app.get<{ Params: { id: string } }>('/rewards/claims/:id', async (req, reply) => {
    const given = bearer(req);
    if (!uuid(req.params.id) || !/^[0-9a-f]{64}$/.test(given)
      || !timingSafeEqual(Buffer.from(given), Buffer.from(receiptFor(req.params.id.toLowerCase()))))
      return reply.code(404).send({ error: 'claim_not_found' });
    const row = (await pool.query<{ id: string; status: string; wallet: string; created_at: Date; actor_id: string;
      amount_micro: string; network: string; tx_hash: string | null; reported_tx: string | null }>(
      `select c.id,c.status,c.wallet,c.created_at,d.actor_id,d.amount_micro::text,d.network,p.tx_hash,
        (select a.transaction_ref from reward_audit a where a.claim_id=c.id and a.action='report_paid' order by a.id desc limit 1) as reported_tx
       from reward_claims c join reward_drops d on d.id=c.drop_id left join reward_verified_payouts p on p.claim_id=c.id
       where c.id=$1`, [req.params.id.toLowerCase()])).rows[0];
    if (!row) return reply.code(404).send({ error: 'claim_not_found' });
    return { claimId: row.id, status: row.status, amount: displayAmount(row.amount_micro), network: row.network,
      animalId: row.actor_id, wallet: `${row.wallet.slice(0, 6)}…${row.wallet.slice(-4)}`,
      claimedAt: row.created_at.toISOString(),
      payment: row.tx_hash ? { transactionRef: row.tx_hash, verified: true }
        : row.reported_tx ? { transactionRef: row.reported_tx, verified: false } : null };
  });

  async function page(kind: PageKind, before: { t?: string; id: string } | null) {
    const limit = PAGE_SIZE + 1;
    let rows: PageRow[];
    if (kind === 'drops') rows = (await pool.query<PageRow>(`select *, ${utcCursorTime} as cursor_time from reward_drops
      where network=$1 and ($2::timestamptz is null or (created_at,id) < ($2::timestamptz,$3::uuid))
      order by created_at desc,id desc limit $4`, [config!.network, before?.t ?? null, before?.id ?? null, limit])).rows;
    else if (kind === 'claims') rows = (await pool.query<PageRow>(`select c.id,c.drop_id,c.wallet,c.status,c.created_at,d.actor_id,d.kind,
      c.agent_id,(select name from live_agents a where a.id=c.agent_id) as agent_name,
      d.amount_micro::text,d.network,p.tx_hash as verified_tx_hash,p.log_index as verified_log_index,
      p.block_number as verified_block_number,p.block_hash as verified_block_hash,p.verified_at,
      ${utcCursorTime.replace('created_at', 'c.created_at')} as cursor_time
      from reward_claims c join reward_drops d on d.id=c.drop_id
      left join reward_verified_payouts p on p.claim_id=c.id where d.network=$1
      and ($2::timestamptz is null or (c.created_at,c.id) < ($2::timestamptz,$3::uuid))
      order by c.created_at desc,c.id desc limit $4`, [config!.network, before?.t ?? null, before?.id ?? null, limit])).rows;
    else rows = (await pool.query<PageRow>(`select * from reward_audit where network=$1 and ($2::bigint is null or id < $2::bigint)
      order by id desc limit $3`, [config!.network, before?.id ?? null, limit])).rows;
    const items = rows.slice(0, PAGE_SIZE);
    const next = rows.length > PAGE_SIZE ? encodeCursor(kind, items.at(-1)!) : null;
    return { items: kind === 'drops' ? (items as unknown as Drop[]).map((d) => ({ ...publicDrop(d), worldId: d.world_id ?? null }))
      : items.map(({ cursor_time: _cursorTime, ...row }) => row), next };
  }
  app.get('/admin/rewards', async () => {
    const world = await currentWorld();
    const [drops, claims, audit] = await Promise.all([page('drops', null), page('claims', null), page('audit', null)]);
    return { drops: drops.items, claims: claims.items, audit: audit.items,
      next: { drops: drops.next, claims: claims.next, audit: audit.next },
      network: config!.network, policy: config!.claimPolicy, currentWorldId: world,
      limits: { minWatchSeconds, walletDailyLimit: config!.walletDailyLimit ?? null, clientDailyLimit: config!.clientDailyLimit ?? null },
      receiptVerificationAvailable: !!receiptRpc && !!walletAddress(config!.payoutWallet, 'base') };
  });
  app.get<{ Querystring: { kind?: string; cursor?: string } }>('/admin/rewards/page', async (req, reply) => {
    const kind = req.query.kind;
    if (kind !== 'drops' && kind !== 'claims' && kind !== 'audit') return reply.code(400).send({ error: 'invalid_page_kind' });
    const before = decodeCursor(kind, req.query.cursor);
    if (!before) return reply.code(400).send({ error: 'invalid_page_cursor' });
    return page(kind, before);
  });
  app.post('/admin/rewards/verify-receipt', { bodyLimit: 1024 }, async (req, reply) => {
    if (!receiptRpc || !config?.payoutWallet) return reply.code(503).send({ receiptMatched: false, reason: 'receipt_verifier_not_configured' });
    const b = bodyOf(req);
    if (!uuid(b.dropId) || !uuid(b.claimId) || typeof b.transactionRef !== 'string'
      || !/^0x[0-9a-fA-F]{64}$/.test(b.transactionRef)
      || !Number.isSafeInteger(b.logIndex) || (b.logIndex as number) < 0 || (b.logIndex as number) > 1_000_000)
      return reply.code(400).send({ receiptMatched: false, reason: 'invalid_receipt_query' });
    const found = await pool.query<{ amount_micro: string; wallet: string }>(`select d.amount_micro::text,c.wallet
      from reward_drops d join reward_claims c on c.drop_id=d.id
      where d.id=$1 and c.id=$2 and d.network='base' and d.status='reserved' and c.status='reserved'`, [b.dropId, b.claimId]);
    const claim = found.rows[0];
    if (!claim) return reply.code(409).send({ receiptMatched: false, reason: 'reservation_not_current' });
    const reused = await pool.query('select 1 from reward_audit where network=$1 and transaction_ref=$2 limit 1',
      ['base', b.transactionRef.toLowerCase()]);
    if (reused.rowCount) return reply.code(409).send({ receiptMatched: false, reason: 'transaction_reference_already_recorded' });
    const result = await matchBaseUsdcReceipt(receiptRpc, { txHash: b.transactionRef, logIndex: b.logIndex as number,
      from: config.payoutWallet, to: claim.wallet, amountMicro: claim.amount_micro });
    return { receiptMatched: result.matched, ...result, paymentVerified: false, recorded: false,
      notice: 'Read-only point-in-time RPC match only; not a treasury balance, payment action, or ledger transition.' };
  });
  app.post('/admin/rewards/settle-verified', { bodyLimit: 1024 }, async (req, reply) => {
    if (!receiptRpc || !config?.payoutWallet || !walletAddress(config.payoutWallet, 'base'))
      return reply.code(503).send({ error: 'receipt_verifier_not_configured' });
    const b = bodyOf(req);
    if (!uuid(b.dropId) || !uuid(b.claimId) || typeof b.transactionRef !== 'string'
      || !/^0x[0-9a-fA-F]{64}$/.test(b.transactionRef) || /^0x0{64}$/i.test(b.transactionRef)
      || !Number.isSafeInteger(b.logIndex) || (b.logIndex as number) < 0 || (b.logIndex as number) > 1_000_000)
      return reply.code(400).send({ error: 'invalid_settlement_proof' });
    const txHash = b.transactionRef.toLowerCase(), logIndex = b.logIndex as number;
    const keys = [b.dropId, b.claimId];
    const previous = (await pool.query<ReservedPayout>(`select d.amount_micro::text,c.wallet,
      d.status as drop_status,c.status as claim_status from reward_drops d
      join reward_claims c on c.drop_id=d.id where d.id=$1 and c.id=$2 and d.network='base'`, keys)).rows[0];
    if (!previous) return reply.code(409).send({ error: 'reservation_not_current' });
    if (previous.drop_status === 'verified_paid' && previous.claim_status === 'verified_paid') {
      const proof = (await pool.query<StoredPayout>(`select claim_id,tx_hash,log_index,block_number,block_hash
        from reward_verified_payouts where drop_id=$1`, [b.dropId])).rows[0];
      if (proof?.claim_id === b.claimId && proof.tx_hash === txHash && proof.log_index === logIndex)
        return { ok: true, paymentVerified: true, alreadyRecorded: true, txHash, logIndex,
          blockNumber: proof.block_number, blockHash: proof.block_hash };
      return reply.code(409).send({ error: 'settlement_proof_conflict' });
    }
    if (previous.drop_status !== 'reserved' || previous.claim_status !== 'reserved')
      return reply.code(409).send({ error: 'reservation_not_current' });

    // Network I/O deliberately precedes the transaction. The locked re-read below makes
    // a changed reservation, amount, wallet, or concurrent settlement fail closed.
    const matched = await matchBaseUsdcReceipt(receiptRpc, { txHash, logIndex,
      from: walletAddress(config.payoutWallet, 'base')!, to: previous.wallet, amountMicro: previous.amount_micro });
    if (!matched.matched) return reply.code(409).send({ error: 'receipt_not_verified', reason: matched.reason });
    const db = await pool.connect();
    let committed = false;
    try {
      await db.query('begin');
      const current = (await db.query<ReservedPayout>(`select d.amount_micro::text,c.wallet,
        d.status as drop_status,c.status as claim_status from reward_drops d
        join reward_claims c on c.drop_id=d.id where d.id=$1 and c.id=$2 and d.network='base'
        for update of d,c`, keys)).rows[0];
      if (!current || current.amount_micro !== previous.amount_micro || current.wallet !== previous.wallet
        || current.drop_status !== 'reserved' || current.claim_status !== 'reserved') {
        await db.query('rollback'); return reply.code(409).send({ error: 'reservation_changed_after_verification' });
      }
      const inserted = await db.query(`insert into reward_verified_payouts
        (drop_id,claim_id,network,tx_hash,log_index,block_number,block_hash,token,from_wallet,to_wallet,amount_micro)
        values ($1,$2,'base',$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing returning drop_id`,
      [b.dropId, b.claimId, txHash, logIndex, matched.blockNumber.toLowerCase(), matched.blockHash,
        matched.token, walletAddress(config.payoutWallet, 'base'), current.wallet, current.amount_micro]);
      if (!inserted.rowCount) { await db.query('rollback'); return reply.code(409).send({ error: 'settlement_proof_already_used' }); }
      await db.query("update reward_drops set status='verified_paid' where id=$1 and status='reserved'", [b.dropId]);
      await db.query("update reward_claims set status='verified_paid' where id=$1 and status='reserved'", [b.claimId]);
      await db.query(`insert into reward_audit(drop_id,claim_id,action,network,note)
        values ($1,$2,'verified_paid','base','Exact finalized native Base USDC Transfer recorded; no transfer initiated by VANA')`, keys);
      await db.query('commit'); committed = true;
      return { ok: true, paymentVerified: true, alreadyRecorded: false, txHash, logIndex,
        blockNumber: matched.blockNumber, blockHash: matched.blockHash };
    } catch {
      if (!committed) await db.query('rollback').catch(() => undefined);
      return reply.code(503).send({ error: 'settlement_outcome_uncertain_retry_exact_proof' });
    } finally { db.release(); }
  });
  app.post('/admin/rewards/drops', { bodyLimit: 2048 }, async (req, reply) => {
    const b = bodyOf(req), amount = microAmount(b.amount);
    if (!uuid(b.id) || typeof b.actorId !== 'string' || b.actorId.length > 128 || !subject(b.actorId) || !amount
      || !['watch', 'carcass'].includes(String(b.revealWhen))) return reply.code(400).send({ error: 'invalid_drop' });
    const world = await currentWorld();
    if (world === null) return reply.code(503).send({ error: 'world_unavailable' });
    const db = await pool.connect();
    try {
      await db.query('begin');
      const inserted = await db.query(`insert into reward_drops(id, actor_id, amount_micro, network, reveal_when, world_id)
        values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning id`, [b.id, b.actorId, amount, config!.network, b.revealWhen, world]);
      const drop = (await db.query<Drop>('select * from reward_drops where id=$1', [b.id])).rows[0]!;
      if (drop.world_id !== world || drop.actor_id !== b.actorId || drop.amount_micro !== amount || drop.network !== config!.network || drop.reveal_when !== b.revealWhen) {
        await db.query('rollback'); return reply.code(409).send({ error: 'idempotency_conflict' });
      }
      if (inserted.rowCount) await db.query("insert into reward_audit(drop_id,action,network) values ($1,'allocated',$2)", [b.id, config!.network]);
      await db.query('commit'); return publicDrop(drop);
    } catch { await db.query('rollback'); return reply.code(503).send({ error: 'allocation_unavailable_retry_same_id' }); }
    finally { db.release(); }
  });
  // A batch of place drops at random land spots, for live agents to find and open.
  app.post('/admin/rewards/place-drops', { bodyLimit: 2048 }, async (req, reply) => {
    if (!deps.placeDrops) return reply.code(503).send({ error: 'live_agents_not_enabled' });
    const b = bodyOf(req), amount = microAmount(b.amount);
    const count = Number(b.count ?? 1), spacing = Number(b.spacingMinutes ?? 10), lifetime = Number(b.lifetimeMinutes ?? 60);
    if (!uuid(b.batchId) || !amount || !Number.isInteger(count) || count < 1 || count > 50
      || !Number.isInteger(spacing) || spacing < 0 || spacing > 1440 || !Number.isInteger(lifetime) || lifetime < 5 || lifetime > 1440)
      return reply.code(400).send({ error: 'invalid_place_drops' });
    if (await currentWorld() === null) return reply.code(503).send({ error: 'world_unavailable' });
    try {
      const result = await deps.placeDrops.ledger.createBatch({ batchId: b.batchId, amountMicro: amount, count,
        spacingMinutes: spacing, lifetimeMinutes: lifetime }, deps.placeDrops.spot);
      await deps.placeDrops.ledger.refresh();
      return { ...result, amount: displayAmount(amount) };
    } catch { return reply.code(503).send({ error: 'place_drops_unavailable_retry_same_batch' }); }
  });
  // Under /admin/rewards so the same token check, rate limit and same-origin rule guard it.
  app.post('/admin/rewards/agents/mute', { bodyLimit: 1024 }, async (req, reply) => {
    if (!deps.agents) return reply.code(503).send({ error: 'live_agents_not_enabled' });
    const b = bodyOf(req);
    if (typeof b.agent !== 'string' || !/^[A-Za-z0-9 _-]{2,40}$/.test(b.agent) || typeof b.muted !== 'boolean')
      return reply.code(400).send({ error: 'agent_and_muted_required' });
    const id = await deps.agents.mute(b.agent, b.muted);
    return id ? { agentId: id, muted: b.muted } : reply.code(404).send({ error: 'no_such_agent' });
  });
  app.post('/admin/rewards/review', { bodyLimit: 2048 }, async (req, reply) => {
    const b = bodyOf(req);
    if (!uuid(b.dropId) || !['reject', 'cancel', 'report_paid'].includes(String(b.action))
      || b.action !== 'cancel' && !uuid(b.claimId) || typeof b.note !== 'string' || b.note.trim().length < 5 || b.note.length > 240)
      return reply.code(400).send({ error: 'invalid_review_or_audit_note' });
    if (b.action === 'report_paid' && (typeof b.transactionRef !== 'string'
      || !/^0x[0-9a-fA-F]{64}$/.test(b.transactionRef) || /^0x0{64}$/.test(b.transactionRef)))
      return reply.code(400).send({ error: 'transaction_reference_required' });
    const tx = typeof b.transactionRef === 'string' ? b.transactionRef.toLowerCase() : null;
    const db = await pool.connect();
    try {
      await db.query('begin');
      const drop = (await db.query<Drop>('select * from reward_drops where id=$1 for update', [b.dropId])).rows[0];
      if (!drop || drop.network !== config!.network) { await db.query('rollback'); return reply.code(404).send({ error: 'not_found' }); }
      const claim = b.action === 'cancel' ? null : (await db.query<{ id: string; status: string }>(
        'select id, status from reward_claims where id=$1 and drop_id=$2', [b.claimId, drop.id])).rows[0];
      const ok = b.action === 'cancel' ? drop.status === 'open'
        : drop.status === 'reserved' && claim?.status === 'reserved';
      if (!ok) { await db.query('rollback'); return reply.code(409).send({ error: 'state_changed_refresh_before_action' }); }
      if (b.action === 'cancel') {
        await db.query("update reward_drops set status='cancelled' where id=$1", [drop.id]);
      } else if (b.action === 'reject') {
        await db.query("update reward_claims set status='rejected' where id=$1", [claim!.id]);
        await db.query("update reward_drops set status='open' where id=$1", [drop.id]);
      }
      else {
        await db.query("update reward_drops set status='paid_reported' where id=$1", [drop.id]);
        await db.query("update reward_claims set status='paid_reported' where id=$1", [claim!.id]);
      }
      await db.query('insert into reward_audit(drop_id,claim_id,action,network,transaction_ref,note) values ($1,$2,$3,$4,$5,$6)',
        [drop.id, claim?.id ?? null, b.action, config!.network, b.action === 'report_paid' ? tx : null, b.note.trim()]);
      await db.query('commit'); return { ok: true, paymentVerified: false };
    } catch { await db.query('rollback'); return reply.code(409).send({ error: 'review_conflict_refresh_before_action' }); }
    finally { db.release(); }
  });
}
