import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from './db/pool.js';
import { baseReceiptRpc, matchBaseUsdcReceipt, type ReceiptRpc } from './baseReceipt.js';

export type RewardNetwork = 'base';
export interface RewardConfig { adminToken: string; network: 'base'; claimPolicy: 'first_valid'; receiptRpcUrl?: string; payoutWallet?: string }
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
interface Drop { id: string; actor_id: string; amount_micro: string; network: RewardNetwork; reveal_when: string; status: string }
interface ReservedPayout { amount_micro: string; wallet: string; drop_status: string; claim_status: string }
interface StoredPayout { claim_id: string; tx_hash: string; log_index: number; block_number: string; block_hash: string }
const publicDrop = (d: Drop) => ({ id: d.id, actorId: d.actor_id, amount: displayAmount(d.amount_micro), network: d.network,
  status: d.status, revealWhen: d.reveal_when });
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
}): void {
  const { pool, config, subject } = deps;
  const receiptRpc = deps.receiptRpc ?? (config?.receiptRpcUrl ? baseReceiptRpc(config.receiptRpcUrl) : undefined);
  const limits = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', async (req, reply) => {
    if (!/^\/(rewards|admin\/rewards)(\/|\?|$)/.test(req.url)) return;
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
    if (req.url.startsWith('/admin/')) {
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

  app.get('/rewards/summary', async () => {
    const { rows } = await pool.query<{ status: string; amount: string }>(
      'select status, sum(amount_micro)::text as amount from reward_drops where network=$1 group by status', [config!.network]);
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
    await pool.query('update reward_observers set actor_id=$1 where token_hash=$2', [actorId, viewer.token_hash]);
    if (actorId === null) return { drops: [] };
    const { rows } = await pool.query<Drop>(
      "select * from reward_drops where actor_id=$1 and network=$2 and status='open' order by created_at limit 20", [actorId, config!.network]);
    return { drops: rows.filter(visible).map(publicDrop) };
  });
  app.post('/rewards/claims', { bodyLimit: 2048 }, async (req, reply) => {
    const viewer = await observer(req); if (!viewer) return reply.code(401).send({ error: 'observer_session_required' });
    const body = bodyOf(req), wallet = walletAddress(body.wallet, config!.network);
    if (!uuid(body.dropId) || !wallet) return reply.code(400).send({ error: 'invalid_claim_or_wallet' });
    const db = await pool.connect();
    try {
      await db.query('begin');
      const currentViewer = (await db.query<{ actor_id: string | null }>(
        'select actor_id from reward_observers where token_hash=$1 and expires_at > now() for share', [viewer.token_hash])).rows[0];
      if (!currentViewer) { await db.query('rollback'); return reply.code(401).send({ error: 'observer_session_required' }); }
      const drop = (await db.query<Drop>('select * from reward_drops where id=$1 for update', [body.dropId])).rows[0];
      // Repeated submit returns the same receipt, including after reservation. Never edits the wallet.
      const previous = (await db.query<{ id: string; wallet: string; status: string }>(
        'select id, wallet, status from reward_claims where drop_id=$1 and observer_hash=$2', [body.dropId, viewer.token_hash])).rows[0];
      if (previous && drop) {
        await db.query('rollback');
        if (previous.wallet !== wallet) return reply.code(409).send({ error: 'claim_wallet_immutable' });
        return { claimId: previous.id, status: previous.status, amount: displayAmount(drop.amount_micro), network: drop.network };
      }
      if (!drop || drop.network !== config!.network || currentViewer.actor_id !== drop.actor_id || !visible(drop)) {
        await db.query('rollback'); return reply.code(404).send({ error: 'watch_subject_to_claim' });
      }
      if (drop.status !== 'open') { await db.query('rollback'); return reply.code(409).send({ error: 'reward_unavailable' }); }
      const id = randomUUID();
      const result = await db.query(`insert into reward_claims(id,drop_id,observer_hash,wallet) values ($1,$2,$3,$4)
        on conflict do nothing returning id`, [id, drop.id, viewer.token_hash, wallet]);
      if (!result.rowCount) { await db.query('rollback'); return reply.code(409).send({ error: 'wallet_already_submitted' }); }
      await db.query("update reward_drops set status='reserved' where id=$1", [drop.id]);
      await db.query("insert into reward_audit(drop_id,claim_id,action,network) values ($1,$2,'claim_submitted',$3)", [drop.id, id, drop.network]);
      await db.query('commit');
      return { claimId: id, status: 'reserved', amount: displayAmount(drop.amount_micro), network: drop.network };
    } catch { await db.query('rollback'); return reply.code(503).send({ error: 'claim_unavailable_retry_same_details' }); }
    finally { db.release(); }
  });

  async function page(kind: PageKind, before: { t?: string; id: string } | null) {
    const limit = PAGE_SIZE + 1;
    let rows: PageRow[];
    if (kind === 'drops') rows = (await pool.query<PageRow>(`select *, ${utcCursorTime} as cursor_time from reward_drops
      where network=$1 and ($2::timestamptz is null or (created_at,id) < ($2::timestamptz,$3::uuid))
      order by created_at desc,id desc limit $4`, [config!.network, before?.t ?? null, before?.id ?? null, limit])).rows;
    else if (kind === 'claims') rows = (await pool.query<PageRow>(`select c.id,c.drop_id,c.wallet,c.status,c.created_at,d.actor_id,
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
    return { items: kind === 'drops' ? (items as unknown as Drop[]).map(publicDrop)
      : items.map(({ cursor_time: _cursorTime, ...row }) => row), next };
  }
  app.get('/admin/rewards', async () => {
    const [drops, claims, audit] = await Promise.all([page('drops', null), page('claims', null), page('audit', null)]);
    return { drops: drops.items, claims: claims.items, audit: audit.items,
      next: { drops: drops.next, claims: claims.next, audit: audit.next },
      network: config!.network, policy: config!.claimPolicy,
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
    const db = await pool.connect();
    try {
      await db.query('begin');
      const inserted = await db.query(`insert into reward_drops(id, actor_id, amount_micro, network, reveal_when)
        values ($1,$2,$3,$4,$5) on conflict do nothing returning id`, [b.id, b.actorId, amount, config!.network, b.revealWhen]);
      const drop = (await db.query<Drop>('select * from reward_drops where id=$1', [b.id])).rows[0]!;
      if (drop.actor_id !== b.actorId || drop.amount_micro !== amount || drop.network !== config!.network || drop.reveal_when !== b.revealWhen) {
        await db.query('rollback'); return reply.code(409).send({ error: 'idempotency_conflict' });
      }
      if (inserted.rowCount) await db.query("insert into reward_audit(drop_id,action,network) values ($1,'allocated',$2)", [b.id, config!.network]);
      await db.query('commit'); return publicDrop(drop);
    } catch { await db.query('rollback'); return reply.code(503).send({ error: 'allocation_unavailable_retry_same_id' }); }
    finally { db.release(); }
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
