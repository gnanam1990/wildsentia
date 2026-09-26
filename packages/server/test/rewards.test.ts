import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { buildApi } from '../src/api.js';
import { displayAmount, microAmount, rewardConfig, walletAddress } from '../src/rewards.js';
import { BASE_USDC, ERC20_TRANSFER_TOPIC, type ReceiptRpc } from '../src/baseReceipt.js';
import { testDatabaseUrl } from './testDatabase.js';
import { makeCarcass, takeSnapshot } from '@vana/sim';

describe('reward validation', () => {
  it('requires explicit Base first-valid configuration and a private admin credential', () => {
    expect(rewardConfig({})).toBeUndefined();
    expect(() => rewardConfig({ VANA_REWARD_NETWORK: 'base' })).toThrow();
    expect(() => rewardConfig({ VANA_REWARD_NETWORK: 'ethereum', VANA_REWARD_POLICY: 'first_valid', VANA_REWARD_ADMIN_TOKEN: 'test-only-'.repeat(5) })).toThrow();
    for (const badToken of ['a'.repeat(31), 'a'.repeat(257), `${'a'.repeat(32)} `, `a\n${'b'.repeat(32)}`])
      expect(() => rewardConfig({ VANA_REWARD_NETWORK: 'base', VANA_REWARD_POLICY: 'first_valid', VANA_REWARD_ADMIN_TOKEN: badToken })).toThrow();
    expect(rewardConfig({ VANA_REWARD_NETWORK: 'base', VANA_REWARD_POLICY: 'first_valid', VANA_REWARD_ADMIN_TOKEN: 'a'.repeat(256) })?.adminToken).toHaveLength(256);
    expect(rewardConfig({ VANA_REWARD_NETWORK: 'base', VANA_REWARD_POLICY: 'first_valid', VANA_REWARD_ADMIN_TOKEN: 'test-only-'.repeat(5) })?.network).toBe('base');
    const base = { VANA_REWARD_NETWORK: 'base', VANA_REWARD_POLICY: 'first_valid', VANA_REWARD_ADMIN_TOKEN: 'test-only-'.repeat(5) };
    expect(() => rewardConfig({ ...base, VANA_REWARD_RECEIPT_RPC_URL: 'https://example.org/rpc' })).toThrow();
    expect(() => rewardConfig({ ...base, VANA_REWARD_PAYOUT_WALLET: '0x' + '1'.repeat(40) })).toThrow();
    expect(() => rewardConfig({ ...base, VANA_REWARD_RECEIPT_RPC_URL: 'http://example.org/rpc', VANA_REWARD_PAYOUT_WALLET: '0x' + '1'.repeat(40) })).toThrow();
    expect(rewardConfig({ ...base, VANA_REWARD_RECEIPT_RPC_URL: 'https://example.org/rpc', VANA_REWARD_PAYOUT_WALLET: '0x' + '1'.repeat(40) })?.payoutWallet)
      .toBe('0x' + '1'.repeat(40));
  });
  it('uses exact micro amounts and rejects rounding, exponent notation and excessive amounts', () => {
    expect(microAmount('0.000001')).toBe('1'); expect(microAmount('12.345678')).toBe('12345678');
    expect(displayAmount('12345678')).toBe('12.345678');
    for (const bad of ['0', '-1', '1e3', '1.0000001', '1000001', ' 1', '01', 'NaN', 5]) expect(microAmount(bad)).toBeNull();
    expect(displayAmount('9007199254740991000')).toBe('9007199254740.991000');
  });
  it('validates Base address shape, rejects zero and checks mixed-case EIP-55', () => {
    const valid = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(walletAddress(valid, 'base')).toBe(valid.toLowerCase());
    expect(walletAddress(valid.toLowerCase(), 'base')).toBe(valid.toLowerCase());
    expect(walletAddress(valid.replace('5aAe', '5aae'), 'base')).toBeNull();
    for (const bad of ['0x' + '0'.repeat(40), 'abc', valid + ' ', '<script>', 42]) expect(walletAddress(bad, 'base')).toBeNull();
  });
});

const url = testDatabaseUrl();
const pool = url ? createPool(url) : null;
const maybe = url ? describe : describe.skip;
const adminToken = 'local-fixture-only-'.repeat(3);
const admin = { authorization: `Bearer ${adminToken}` };
let host: SimHost, app: FastifyInstance, actorId: string;
const post = (path: string, payload: object, token?: string) => app.inject({ method: 'POST', url: path, payload,
  headers: token ? { authorization: `Bearer ${token}` } : {} });
const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const payoutTx = (digit: string) => `0x${digit.repeat(64)}`;
const payoutBlock = payoutTx('b');
function payoutReceiptRpc(tx: string, from: string, to: string, amountMicro = '5000001', logIndex = 7,
  change: { chain?: string; finalized?: string; block?: string; token?: string; amount?: string; sender?: string; recipient?: string } = {}): ReceiptRpc {
  return async (method, params) => {
    if (method === 'eth_chainId') return change.chain ?? '0x2105';
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: tx,
      blockNumber: '0x64', blockHash: payoutBlock,
      logs: [{ address: change.token ?? BASE_USDC, transactionHash: tx, blockHash: payoutBlock,
        logIndex: `0x${logIndex.toString(16)}`, topics: [ERC20_TRANSFER_TOPIC,
          `0x${'0'.repeat(24)}${(change.sender ?? from).slice(2)}`,
          `0x${'0'.repeat(24)}${(change.recipient ?? to).slice(2)}`],
        data: `0x${BigInt(change.amount ?? amountMicro).toString(16).padStart(64, '0')}` }] };
    return params[0] === 'finalized' ? { number: change.finalized ?? '0x65' }
      : { number: '0x64', hash: change.block ?? payoutBlock };
  };
}
const allocate = async (amount = '5.000001', revealWhen = 'watch') => {
  const id = randomUUID(); const res = await post('/admin/rewards/drops', { id, actorId, amount, revealWhen }, adminToken);
  expect(res.statusCode).toBe(200); return id;
};
const session = async (actor: string | null = actorId) => {
  const res = await post('/rewards/session', {}); expect(res.statusCode).toBe(200);
  const token = res.json().token as string;
  expect((await post('/rewards/watch', { actorId: actor }, token)).statusCode).toBe(200); return token;
};
maybe('private manual Base reward ledger', () => {
  beforeAll(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
    host = new SimHost({ pool: pool!, seed: 4, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null });
    await host.boot(); actorId = host.world.agents[0]!.id;
    app = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid' } }); await app.ready();
  });
  beforeEach(async () => { await pool!.query('truncate reward_audit, reward_claims, reward_drops, reward_observers cascade'); });
  afterAll(async () => { await app?.close(); await host?.abort(); await pool?.end(); });
  it('fails closed when disabled, rejects unauthorized administration and cross-site writes', async () => {
    const disabled = buildApi({ host, pool: pool! });
    try { expect((await disabled.inject('/rewards/summary')).statusCode).toBe(503); } finally { await disabled.close(); }
    expect((await app.inject('/admin/rewards')).statusCode).toBe(401);
    expect((await post('/admin/rewards/drops', {}, 'wrong-key')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/rewards/session', payload: {}, headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect((await post('/rewards/claims', {})).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/rewards/session', headers: { 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
  });
  it('rate-limits rejected administrator attempts before checking a later valid credential', async () => {
    const remoteAddress = '127.0.0.33';
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({ url: '/admin/rewards', remoteAddress, headers: { authorization: 'Bearer wrong-key' } });
      expect(res.statusCode).toBe(401);
    }
    const limited = await app.inject({ url: '/admin/rewards', remoteAddress, headers: admin });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
  });
  it('allocates idempotently, locks immutable details, and exposes only aggregate public totals', async () => {
    const id = randomUUID(); const body = { id, actorId, amount: '7.123456', revealWhen: 'watch' };
    expect((await post('/admin/rewards/drops', body, adminToken)).statusCode).toBe(200);
    expect((await post('/admin/rewards/drops', body, adminToken)).statusCode).toBe(200);
    expect((await post('/admin/rewards/drops', { ...body, amount: '8' }, adminToken)).statusCode).toBe(409);
    const summary = await app.inject('/rewards/summary'); expect(summary.json()).toMatchObject({ available: '7.123456', fundingVerified: false, network: 'base' });
    expect(summary.body).not.toContain(actorId); expect(summary.body).not.toContain(id);
    expect(summary.headers['cache-control']).toBe('no-store');
    expect((await pool!.query('select * from reward_audit')).rows).toHaveLength(1);
  });
  it('reveals a hidden drop only for the selected animal, never by an unrelated claim', async () => {
    const id = await allocate(), other = host.world.agents[1]!.id;
    const token = await session(other);
    expect((await post('/rewards/watch', { actorId: other }, token)).json().drops).toEqual([]);
    expect((await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).statusCode).toBe(404);
    expect((await post('/rewards/watch', { actorId }, token)).json().drops).toHaveLength(1);
    expect((await post('/rewards/watch', { actorId: null }, token)).json().drops).toEqual([]);
    expect((await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).statusCode).toBe(404);
  });
  it('hides a carcass-only drop until remains exist, and never fabricates a death', async () => {
    const id = await allocate('3', 'carcass'), token = await session();
    expect((await post('/rewards/watch', { actorId }, token)).json().drops).toEqual([]);
    const corpse = makeCarcass('test-corpse', actorId, 'sambar', 0, host.world.now(), 'natural', 'authoritative', 100);
    host.world.carcasses.push(corpse);
    try {
      expect((await post('/rewards/watch', { actorId }, token)).json().drops).toEqual([]);
      await host.snapshotNow();
      expect((await post('/rewards/watch', { actorId }, token)).json().drops[0].id).toBe(id);
    } finally { host.world.carcasses.splice(host.world.carcasses.indexOf(corpse), 1); await host.snapshotNow(); }
    expect((await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).statusCode).toBe(404);
  });
  it('reserves exactly once under simultaneous valid claims, with exact totals and private wallets', async () => {
    const id = await allocate(), a = await session(), b = await session();
    const before = takeSnapshot(host.world);
    const results = await Promise.all([post('/rewards/claims', { dropId: id, wallet: wallet(1) }, a), post('/rewards/claims', { dropId: id, wallet: wallet(2) }, b)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await pool!.query('select * from reward_claims')).rows).toHaveLength(1);
    expect((await app.inject('/rewards/summary')).json()).toMatchObject({ available: '0.000000', reserved: '5.000001' });
    const winner = results[0]!.statusCode === 200 ? a : b, address = results[0]!.statusCode === 200 ? wallet(1) : wallet(2);
    const again = await post('/rewards/claims', { dropId: id, wallet: address }, winner);
    expect(again.json().claimId).toBe(results.find((r) => r.statusCode === 200)!.json().claimId);
    expect(again.json().status).toBe('reserved');
    expect((await post('/rewards/claims', { dropId: id, wallet: wallet(3) }, winner)).statusCode).toBe(409);
    const adminView = await app.inject({ url: '/admin/rewards', headers: admin }); expect(adminView.body).toContain(address);
    for (const path of ['/rewards/summary', '/event-map', '/animals', '/world']) expect((await app.inject(path)).body).not.toContain(address);
    expect(takeSnapshot(host.world)).toEqual(before);
  });
  it('gives no priority to an earlier invalid submission and keeps the first accepted valid winner', async () => {
    const id = await allocate(), early = await session(), valid = await session();
    expect((await post('/rewards/claims', { dropId: id, wallet: 'invalid' }, early)).statusCode).toBe(400);
    const accepted = await post('/rewards/claims', { dropId: id, wallet: wallet(2) }, valid);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('reserved');
    // Fixing an earlier invalid form cannot displace a committed valid reservation.
    expect((await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, early)).statusCode).toBe(409);
    const rows = (await pool!.query('select id, wallet, status from reward_claims where drop_id=$1', [id])).rows;
    expect(rows).toEqual([{ id: accepted.json().claimId, wallet: wallet(2), status: 'reserved' }]);
    expect((await app.inject('/rewards/summary')).json()).toMatchObject({ available: '0.000000', reserved: '5.000001' });
  });
  it('does not reserve malformed wallets or accept expired sessions', async () => {
    const id = await allocate(), token = await session();
    expect((await post('/rewards/claims', { dropId: id, wallet: 'not-a-wallet' }, token)).statusCode).toBe(400);
    await pool!.query("update reward_observers set expires_at=now()-interval '1 second'");
    expect((await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).statusCode).toBe(401);
    expect((await app.inject('/rewards/summary')).json().available).toBe('5.000001');
  });
  it('retains a reservation across API restart and records manual payment without claiming verification', async () => {
    const id = await allocate(), token = await session();
    const claim = (await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json();
    await app.close(); app = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid' } }); await app.ready();
    expect((await app.inject('/rewards/summary')).json().reserved).toBe('5.000001');
    const review = { dropId: id, claimId: claim.claimId, action: 'report_paid', transactionRef: '0x' + '1'.repeat(64), note: 'Local fixture; no transaction sent' };
    expect((await post('/admin/rewards/review', { ...review, transactionRef: 'not-a-hash' }, adminToken)).statusCode).toBe(400);
    const res = await post('/admin/rewards/review', review, adminToken); expect(res.json()).toEqual({ ok: true, paymentVerified: false });
    expect((await app.inject('/rewards/summary')).json()).toMatchObject({ available: '0.000000', reserved: '0.000000', paidReported: '5.000001' });
    expect((await post('/admin/rewards/review', review, adminToken)).statusCode).toBe(409);
    expect((await post('/admin/rewards/review', { ...review, action: 'reject' }, adminToken)).statusCode).toBe(409);
  });
  it('rolls back payment-report transitions if the same transaction reference was already used', async () => {
    const token = await session(); const tx = '0x' + '2'.repeat(64);
    for (let i = 0; i < 2; i++) {
      const id = await allocate(), claim = (await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json();
      const res = await post('/admin/rewards/review', { dropId: id, claimId: claim.claimId, action: 'report_paid', transactionRef: tx, note: 'Local test only' }, adminToken);
      expect(res.statusCode).toBe(i === 0 ? 200 : 409);
    }
    expect((await app.inject('/rewards/summary')).json()).toMatchObject({ reserved: '5.000001', paidReported: '5.000001' });
  });
  it('offers a read-only finalized receipt check bound to the current claim and configured payout sender', async () => {
    const id = await allocate(), token = await session();
    const claim = (await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json();
    const tx = `0x${'a'.repeat(64)}`, block = `0x${'b'.repeat(64)}`, from = wallet(9);
    const receiptRpc: ReceiptRpc = async (method, params) => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: tx, blockNumber: '0x64', blockHash: block,
        logs: [{ address: BASE_USDC, transactionHash: tx, blockHash: block, logIndex: '0x7',
          topics: [ERC20_TRANSFER_TOPIC, `0x${'0'.repeat(24)}${from.slice(2)}`, `0x${'0'.repeat(24)}${wallet(1).slice(2)}`],
          data: `0x${5000001n.toString(16).padStart(64, '0')}` }] };
      return params[0] === 'finalized' ? { number: '0x65' } : { number: '0x64', hash: block };
    };
    const verifier = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid',
      receiptRpcUrl: 'https://example.org/rpc', payoutWallet: from }, receiptRpc });
    await verifier.ready();
    try {
      const body = { dropId: id, claimId: claim.claimId, transactionRef: tx, logIndex: 7 };
      expect((await verifier.inject({ method: 'POST', url: '/admin/rewards/verify-receipt', payload: body })).statusCode).toBe(401);
      const result = await verifier.inject({ method: 'POST', url: '/admin/rewards/verify-receipt', payload: body, headers: admin });
      expect(result.json()).toMatchObject({ receiptMatched: true, paymentVerified: false, recorded: false, txHash: tx });
      expect((await app.inject('/rewards/summary')).json()).toMatchObject({ reserved: '5.000001', paidReported: '0.000000' });
      expect((await pool!.query('select * from reward_audit where action=$1', ['report_paid'])).rows).toHaveLength(0);
      expect((await verifier.inject({ method: 'POST', url: '/admin/rewards/verify-receipt',
        payload: { ...body, claimId: randomUUID() }, headers: admin })).statusCode).toBe(409);
    } finally { await verifier.close(); }
  });
  it('records only the exact finalized Base USDC transfer, survives restart, and retries idempotently', async () => {
    const id = await allocate(), token = await session();
    const claimId = (await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json().claimId as string;
    const tx = payoutTx('a'), from = wallet(9);
    const config = { adminToken, network: 'base' as const, claimPolicy: 'first_valid' as const,
      receiptRpcUrl: 'https://example.org/rpc', payoutWallet: from };
    const verifier = buildApi({ host, pool: pool!, rewards: config,
      receiptRpc: payoutReceiptRpc(tx, from, wallet(1)) });
    await verifier.ready();
    let verifierClosed = false;
    const body = { dropId: id, claimId, transactionRef: tx, logIndex: 7 };
    const before = takeSnapshot(host.world);
    try {
      expect((await verifier.inject({ method: 'POST', url: '/admin/rewards/settle-verified', payload: body })).statusCode).toBe(401);
      expect((await post('/admin/rewards/settle-verified', body, adminToken)).statusCode).toBe(503);
      const first = await verifier.inject({ method: 'POST', url: '/admin/rewards/settle-verified', payload: body, headers: admin });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ ok: true, paymentVerified: true, alreadyRecorded: false,
        txHash: tx, logIndex: 7, blockHash: payoutBlock });
      expect((await app.inject('/rewards/summary')).json()).toMatchObject({ reserved: '0.000000',
        paidReported: '0.000000', verifiedPaid: '5.000001', fundingVerified: false });
      const ledger = (await verifier.inject({ url: '/admin/rewards', headers: admin })).json();
      expect(ledger.claims[0]).toMatchObject({ id: claimId, status: 'verified_paid', verified_tx_hash: tx,
        verified_log_index: 7, verified_block_hash: payoutBlock });
      expect(ledger.audit[0]).toMatchObject({ action: 'verified_paid', claim_id: claimId });
      expect((await pool!.query('select status from reward_drops where id=$1', [id])).rows[0].status).toBe('verified_paid');
      expect((await pool!.query('select status from reward_claims where id=$1', [claimId])).rows[0].status).toBe('verified_paid');
      expect(takeSnapshot(host.world)).toEqual(before);
      await verifier.close(); verifierClosed = true;
      const restarted = buildApi({ host, pool: pool!, rewards: config,
        receiptRpc: async () => { throw new Error('RPC offline after the committed historical verification'); } });
      await restarted.ready();
      try {
        const retry = await restarted.inject({ method: 'POST', url: '/admin/rewards/settle-verified', payload: body, headers: admin });
        expect(retry.json()).toMatchObject({ ok: true, paymentVerified: true, alreadyRecorded: true, txHash: tx });
        expect((await restarted.inject({ method: 'POST', url: '/admin/rewards/settle-verified',
          payload: { ...body, logIndex: 8 }, headers: admin })).statusCode).toBe(409);
        expect((await pool!.query("select count(*)::int as count from reward_audit where action='verified_paid'")).rows[0].count).toBe(1);
      } finally { await restarted.close(); }
    } finally { if (!verifierClosed) await verifier.close(); }
  });
  it('fails closed on unknown, unfinalized, reorged, or mismatched RPC evidence without touching the reservation', async () => {
    const id = await allocate(), token = await session();
    const claimId = (await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json().claimId as string;
    const tx = payoutTx('c'), from = wallet(9), body = { dropId: id, claimId, transactionRef: tx, logIndex: 7 };
    const bad: ReceiptRpc[] = [
      async () => { throw new Error('RPC unavailable'); },
      payoutReceiptRpc(tx, from, wallet(1), '5000001', 7, { chain: '0x1' }),
      payoutReceiptRpc(tx, from, wallet(1), '5000001', 7, { finalized: '0x63' }),
      payoutReceiptRpc(tx, from, wallet(1), '5000001', 7, { block: payoutTx('d') }),
      payoutReceiptRpc(tx, from, wallet(1), '5000001', 7, { token: wallet(8) }),
      payoutReceiptRpc(tx, from, wallet(1), '5000001', 7, { amount: '5000002' }),
      payoutReceiptRpc(tx, from, wallet(1), '5000001', 7, { sender: wallet(8) }),
      payoutReceiptRpc(tx, from, wallet(1), '5000001', 7, { recipient: wallet(8) }),
    ];
    for (const receiptRpc of bad) {
      const verifier = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid',
        receiptRpcUrl: 'https://example.org/rpc', payoutWallet: from }, receiptRpc });
      await verifier.ready();
      try {
        const response = await verifier.inject({ method: 'POST', url: '/admin/rewards/settle-verified', payload: body, headers: admin });
        expect(response.statusCode).toBe(409);
        expect(response.json().paymentVerified).not.toBe(true);
      } finally { await verifier.close(); }
    }
    expect((await pool!.query('select count(*)::int as count from reward_verified_payouts')).rows[0].count).toBe(0);
    expect((await app.inject('/rewards/summary')).json()).toMatchObject({ reserved: '5.000001', verifiedPaid: '0.000000' });
  });
  it('rechecks locked claim state after RPC and cannot settle a concurrently rejected reservation', async () => {
    const id = await allocate(), token = await session();
    const claimId = (await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json().claimId as string;
    const tx = payoutTx('d'), from = wallet(9);
    let entered!: () => void, release!: () => void;
    const atRpc = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const good = payoutReceiptRpc(tx, from, wallet(1));
    const receiptRpc: ReceiptRpc = async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === '0x64') { entered(); await gate; }
      return good(method, params);
    };
    const verifier = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid',
      receiptRpcUrl: 'https://example.org/rpc', payoutWallet: from }, receiptRpc });
    await verifier.ready();
    try {
      const pending = verifier.inject({ method: 'POST', url: '/admin/rewards/settle-verified',
        payload: { dropId: id, claimId, transactionRef: tx, logIndex: 7 }, headers: admin });
      await atRpc;
      expect((await post('/admin/rewards/review', { dropId: id, claimId, action: 'reject',
        note: 'No payout initiated, claim invalid' }, adminToken)).statusCode).toBe(200);
      release();
      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('reservation_changed_after_verification');
      expect((await pool!.query('select count(*)::int as count from reward_verified_payouts')).rows[0].count).toBe(0);
    } finally { release(); await verifier.close(); }
  });
  it('rejects a database amount change during RPC even when the original receipt matched', async () => {
    const id = await allocate(), token = await session();
    const claimId = (await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json().claimId as string;
    const tx = payoutTx('f'), from = wallet(9);
    let entered!: () => void, release!: () => void;
    const atRpc = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const good = payoutReceiptRpc(tx, from, wallet(1));
    const receiptRpc: ReceiptRpc = async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === '0x64') { entered(); await gate; }
      return good(method, params);
    };
    const verifier = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid',
      receiptRpcUrl: 'https://example.org/rpc', payoutWallet: from }, receiptRpc });
    await verifier.ready();
    try {
      const pending = verifier.inject({ method: 'POST', url: '/admin/rewards/settle-verified',
        payload: { dropId: id, claimId, transactionRef: tx, logIndex: 7 }, headers: admin });
      await atRpc;
      await pool!.query('update reward_drops set amount_micro=5000002 where id=$1', [id]);
      release();
      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('reservation_changed_after_verification');
      expect((await pool!.query('select count(*)::int as count from reward_verified_payouts')).rows[0].count).toBe(0);
    } finally { release(); await verifier.close(); }
  });
  it('keeps historical report_paid unverified even if its receipt later matches', async () => {
    const id = await allocate(), token = await session();
    const claimId = (await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json().claimId as string;
    const tx = payoutTx('6'), from = wallet(9);
    expect((await post('/admin/rewards/review', { dropId: id, claimId, action: 'report_paid',
      transactionRef: tx, note: 'Historic operator assertion' }, adminToken)).statusCode).toBe(200);
    const verifier = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid',
      receiptRpcUrl: 'https://example.org/rpc', payoutWallet: from },
    receiptRpc: payoutReceiptRpc(tx, from, wallet(1)) });
    await verifier.ready();
    try {
      const response = await verifier.inject({ method: 'POST', url: '/admin/rewards/settle-verified',
        payload: { dropId: id, claimId, transactionRef: tx, logIndex: 7 }, headers: admin });
      expect(response.statusCode).toBe(409);
      expect((await app.inject('/rewards/summary')).json()).toMatchObject({ paidReported: '5.000001', verifiedPaid: '0.000000' });
    } finally { await verifier.close(); }
  });
  it('atomically prevents a Transfer log from settling two different reservations', async () => {
    const token = await session(), ids = [await allocate(), await allocate()];
    const claims = [];
    for (const id of ids) claims.push((await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json().claimId as string);
    const tx = payoutTx('e'), from = wallet(9), receiptRpc = payoutReceiptRpc(tx, from, wallet(1));
    const verifier = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid',
      receiptRpcUrl: 'https://example.org/rpc', payoutWallet: from }, receiptRpc });
    await verifier.ready();
    try {
      const responses = await Promise.all(ids.map((dropId, i) => verifier.inject({ method: 'POST',
        url: '/admin/rewards/settle-verified', payload: { dropId, claimId: claims[i], transactionRef: tx, logIndex: 7 }, headers: admin })));
      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect((await pool!.query('select count(*)::int as count from reward_verified_payouts')).rows[0].count).toBe(1);
      expect((await app.inject('/rewards/summary')).json()).toMatchObject({ reserved: '5.000001', verifiedPaid: '5.000001' });
    } finally { await verifier.close(); }
  });
  it('requires a reason for rejecting a reservation, reopening only an unpaid reward', async () => {
    const id = await allocate(), token = await session();
    const claim = (await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json();
    const body = { dropId: id, claimId: claim.claimId, action: 'reject' };
    expect((await post('/admin/rewards/review', body, adminToken)).statusCode).toBe(400);
    expect((await post('/admin/rewards/review', { ...body, note: 'Invalid recipient; no transfer attempted' }, adminToken)).statusCode).toBe(200);
    const other = await session(); expect((await post('/rewards/claims', { dropId: id, wallet: wallet(2) }, other)).statusCode).toBe(200);
    expect((await pool!.query("select * from reward_claims where status='reserved'")).rows).toHaveLength(1);
    expect((await pool!.query('select note from reward_audit where action=$1', ['reject'])).rows[0].note).toContain('no transfer');
  });
  it('hashes observer credentials at rest and never sends them in the admin ledger', async () => {
    const token = await session();
    const row = (await pool!.query('select * from reward_observers')).rows[0];
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect((await app.inject({ url: '/admin/rewards', headers: admin })).body).not.toContain(row.token_hash);
  });

  it('rejects forged amount/network values and preserves the server allocation in a claim', async () => {
    const id = await allocate('1.000009'), token = await session();
    const res = await post('/rewards/claims', { dropId: id, wallet: wallet(1), amount: '99999', network: 'ethereum' }, token);
    expect(res.json()).toMatchObject({ amount: '1.000009', network: 'base', status: 'reserved' });
  });

  it('bounds requests and does not advertise hidden rewards when world ownership is unhealthy', async () => {
    await allocate(); const token = await session();
    host.lastError = 'fixture unhealthy writer';
    try { expect((await post('/rewards/watch', { actorId }, token)).statusCode).toBe(400); }
    finally { host.lastError = null; }
    const res = await Promise.all(Array.from({ length: 121 }, () => app.inject({ url: '/rewards/summary', remoteAddress: '127.0.0.9' })));
    expect(res.filter((r) => r.statusCode === 429)).toHaveLength(1);
  });

  it('allows only unreserved allocations to be cancelled, atomically excluding later claims', async () => {
    const id = await allocate(), token = await session();
    expect((await post('/admin/rewards/review', { dropId: id, action: 'cancel', note: 'Campaign ended without a claim' }, adminToken)).statusCode).toBe(200);
    expect((await post('/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).statusCode).toBe(409);
    expect((await app.inject('/rewards/summary')).json().available).toBe('0.000000');
    const reserved = await allocate(); await post('/rewards/claims', { dropId: reserved, wallet: wallet(1) }, token);
    expect((await post('/admin/rewards/review', { dropId: reserved, action: 'cancel', note: 'Must not cancel a reservation' }, adminToken)).statusCode).toBe(409);
  });
  it('pages the complete private ledger without losing same-time rows when new entries arrive', async () => {
    const ids = Array.from({ length: 105 }, () => randomUUID());
    await pool!.query(`insert into reward_drops(id,actor_id,network,amount_micro,reveal_when,status,created_at)
      select id,$2,'base',1000000,'watch','reserved','2020-09-25T12:00:00.123456Z'::timestamptz
      from unnest($1::uuid[]) as input(id)`, [ids, actorId]);
    await pool!.query(`insert into reward_claims(id,drop_id,observer_hash,wallet,status,created_at)
      select input.id,input.drop_id,input.id::text,$2,'reserved','2020-09-25T12:00:00.123456Z'::timestamptz
      from unnest($1::uuid[],$3::uuid[]) as input(id,drop_id)`, [ids.map(() => randomUUID()), wallet(1), ids]);
    await pool!.query(`insert into reward_audit(drop_id,action,network)
      select input.id,'allocated','base' from unnest($1::uuid[]) as input(id)`, [ids]);
    const first = (await app.inject({ url: '/admin/rewards', headers: admin })).json();
    expect(first.drops).toHaveLength(100); expect(first.claims).toHaveLength(100); expect(first.audit).toHaveLength(100);
    expect(first.next.drops).toBeTruthy(); expect(first.next.claims).toBeTruthy(); expect(first.next.audit).toBeTruthy();
    const newest = await allocate();
    for (const kind of ['drops', 'claims', 'audit'] as const) {
      const older = await app.inject({ url: `/admin/rewards/page?kind=${kind}&cursor=${first.next[kind]}`, headers: admin });
      expect(older.statusCode).toBe(200);
      const page = older.json(); expect(page.items).toHaveLength(5); expect(page.next).toBeNull();
      const all = [...first[kind], ...page.items].map((item: { id: string }) => item.id);
      expect(new Set(all).size).toBe(105);
      expect(all).not.toContain(newest);
    }
    expect((await app.inject({ url: '/admin/rewards/page?kind=claims&cursor=broken', headers: admin })).statusCode).toBe(400);
    expect((await app.inject({ url: `/admin/rewards/page?kind=claims&cursor=${first.next.drops}`, headers: admin })).statusCode).toBe(400);
    expect((await app.inject('/admin/rewards/page?kind=claims&cursor=broken')).statusCode).toBe(401);
  });

  const withApp = async (extra: object, run: (other: FastifyInstance) => Promise<void>, deps: object = {}) => {
    const other = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid', ...extra }, ...deps });
    await other.ready();
    try { await run(other); } finally { await other.close(); }
  };
  const call = (target: FastifyInstance, path: string, payload: object, token?: string, remoteAddress?: string) =>
    target.inject({ method: 'POST', url: path, payload, ...(remoteAddress ? { remoteAddress } : {}),
      headers: token ? { authorization: `Bearer ${token}` } : {} });
  const openSession = async (target: FastifyInstance, actor: string, remoteAddress?: string) => {
    const token = (await call(target, '/rewards/session', {}, undefined, remoteAddress)).json().token as string;
    expect((await call(target, '/rewards/watch', { actorId: actor }, token, remoteAddress)).statusCode).toBe(200);
    return token;
  };
  const ageWatch = (token: string, seconds: number) => pool!.query(
    `update reward_observers set watch_started_at = now() - make_interval(secs => $1) where token_hash=$2`,
    [seconds, createHash('sha256').update(token).digest('hex')]);

  it('reads anti-abuse limits from the environment, with defaults, and rejects nonsense', () => {
    const base = { VANA_REWARD_NETWORK: 'base', VANA_REWARD_POLICY: 'first_valid', VANA_REWARD_ADMIN_TOKEN: 'test-only-'.repeat(5) };
    expect(rewardConfig(base)).toMatchObject({ minWatchSeconds: 60, walletDailyLimit: 1, clientDailyLimit: 3 });
    expect(rewardConfig({ ...base, VANA_REWARD_MIN_WATCH_SECONDS: '0', VANA_REWARD_WALLET_DAILY_LIMIT: '5', VANA_REWARD_CLIENT_DAILY_LIMIT: '20' }))
      .toMatchObject({ minWatchSeconds: 0, walletDailyLimit: 5, clientDailyLimit: 20 });
    for (const [key, bad] of [['VANA_REWARD_MIN_WATCH_SECONDS', '-1'], ['VANA_REWARD_MIN_WATCH_SECONDS', '3601'],
      ['VANA_REWARD_WALLET_DAILY_LIMIT', '0'], ['VANA_REWARD_CLIENT_DAILY_LIMIT', '1.5'], ['VANA_REWARD_CLIENT_DAILY_LIMIT', 'many']])
      expect(() => rewardConfig({ ...base, [key!]: bad })).toThrow();
  });

  it('accepts a claim only after the observer has watched the animal long enough, and restarts on a change', async () => {
    await withApp({ minWatchSeconds: 60 }, async (other) => {
      const id = await allocate(), token = await openSession(other, actorId);
      const early = await call(other, '/rewards/claims', { dropId: id, wallet: wallet(1) }, token);
      expect(early.statusCode).toBe(425);
      expect(early.json()).toMatchObject({ error: 'keep_watching' });
      expect(early.json().retryAfterSeconds).toBeGreaterThan(55);
      // Re-sending the same subject keeps the clock; switching away and back restarts it.
      await ageWatch(token, 50);
      expect((await call(other, '/rewards/watch', { actorId }, token)).json().claimableInSeconds).toBeLessThanOrEqual(10);
      await call(other, '/rewards/watch', { actorId: host.world.agents[1]!.id }, token);
      expect((await call(other, '/rewards/watch', { actorId }, token)).json().claimableInSeconds).toBeGreaterThan(55);
      await ageWatch(token, 61);
      expect((await call(other, '/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).json().status).toBe('reserved');
    });
  });

  it('caps winning claims per wallet and per network address in any 24 hours', async () => {
    await withApp({ walletDailyLimit: 1, clientDailyLimit: 2 }, async (other) => {
      const [a, b, c, d] = [await allocate(), await allocate(), await allocate(), await allocate()];
      const s1 = await openSession(other, actorId, '10.0.0.1');
      expect((await call(other, '/rewards/claims', { dropId: a, wallet: wallet(1) }, s1, '10.0.0.1')).statusCode).toBe(200);
      const s2 = await openSession(other, actorId, '10.0.0.2');
      const again = await call(other, '/rewards/claims', { dropId: b, wallet: wallet(1) }, s2, '10.0.0.2');
      expect(again.statusCode).toBe(429); expect(again.json().error).toBe('wallet_daily_limit');
      // The refused drop stays open for someone else.
      expect((await call(other, '/rewards/claims', { dropId: b, wallet: wallet(2) }, s2, '10.0.0.2')).statusCode).toBe(200);
      const s3 = await openSession(other, actorId, '10.0.0.1');
      expect((await call(other, '/rewards/claims', { dropId: c, wallet: wallet(3) }, s3, '10.0.0.1')).statusCode).toBe(200);
      const s4 = await openSession(other, actorId, '10.0.0.1');
      const third = await call(other, '/rewards/claims', { dropId: d, wallet: wallet(4) }, s4, '10.0.0.1');
      expect(third.statusCode).toBe(429); expect(third.json().error).toBe('client_daily_limit');
      // Only a keyed hash of the address is stored.
      const stored = (await pool!.query('select client_hash from reward_claims')).rows.map((r: { client_hash: string }) => r.client_hash);
      expect(stored.every((h: string) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
      expect(JSON.stringify(stored)).not.toContain('10.0.0.1');
    });
  });

  it('lets a claimant check their own claim with its receipt, and nobody else', async () => {
    const id = await allocate(), token = await session();
    const claim = (await post('/rewards/claims', { dropId: id, wallet: wallet(7) }, token)).json();
    expect(claim.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect((await post('/rewards/claims', { dropId: id, wallet: wallet(7) }, token)).json().receipt).toBe(claim.receipt);
    const status = (receipt: string, claimId = claim.claimId) => app.inject({ url: `/rewards/claims/${claimId}`, headers: { authorization: `Bearer ${receipt}` } });
    const reserved = await status(claim.receipt);
    expect(reserved.statusCode).toBe(200);
    expect(reserved.json()).toMatchObject({ status: 'reserved', amount: '5.000001', network: 'base', animalId: actorId, payment: null });
    expect(reserved.json().wallet).toBe(`${wallet(7).slice(0, 6)}…${wallet(7).slice(-4)}`);
    expect(reserved.headers['cache-control']).toBe('no-store');
    expect((await status('f'.repeat(64))).statusCode).toBe(404);
    expect((await status(claim.receipt, randomUUID())).statusCode).toBe(404);
    expect((await app.inject(`/rewards/claims/${claim.claimId}`)).statusCode).toBe(404);
    const tx = `0x${'4'.repeat(64)}`;
    expect((await post('/admin/rewards/review', { dropId: id, claimId: claim.claimId, action: 'report_paid', transactionRef: tx,
      note: 'Local test only' }, adminToken)).statusCode).toBe(200);
    expect((await status(claim.receipt)).json()).toMatchObject({ status: 'paid_reported', payment: { transactionRef: tx, verified: false } });
  });

  it('keeps a drop in the world it was allocated in', async () => {
    const id = await allocate();
    expect((await pool!.query('select world_id from reward_drops where id=$1', [id])).rows[0].world_id).toBe(host.worldId);
    // The same actor ID in a different world is a different animal: nothing to see or claim.
    const elsewhere = new Proxy(host, { get(target, key) {
      if (key === 'worldId') return '00000000-0000-4000-8000-000000000001';
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await withApp({}, async (other) => {
      const token = await openSession(other, actorId);
      expect((await call(other, '/rewards/watch', { actorId }, token)).json().drops).toEqual([]);
      expect((await call(other, '/rewards/claims', { dropId: id, wallet: wallet(1) }, token)).statusCode).toBe(404);
      expect((await other.inject('/rewards/summary')).json().available).toBe('0.000000');
      const ledger = (await other.inject({ url: '/admin/rewards', headers: admin })).json();
      expect(ledger.currentWorldId).toBe('00000000-0000-4000-8000-000000000001');
      expect(ledger.drops[0]).toMatchObject({ id, worldId: host.worldId });
    }, { host: elsewhere });
    // A drop saved before world identities existed is bound to the running world.
    const legacy = randomUUID();
    await pool!.query(`insert into reward_drops(id,actor_id,network,amount_micro,reveal_when) values ($1,$2,'base',1000000,'watch')`, [legacy, actorId]);
    await app.close(); app = buildApi({ host, pool: pool!, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid' } }); await app.ready();
    expect((await app.inject('/rewards/summary')).json().available).toBe('6.000001');
    expect((await pool!.query('select world_id from reward_drops where id=$1', [legacy])).rows[0].world_id).toBe(host.worldId);
  });

  it('limits each visitor behind the proxy separately, and only when the proxy is trusted', async () => {
    const hammer = async (target: FastifyInstance, forwarded: string) => {
      let last = 0;
      for (let i = 0; i < 121; i++) last = (await target.inject({ url: '/rewards/summary', remoteAddress: '172.18.0.5',
        headers: { 'x-forwarded-for': forwarded } })).statusCode;
      return last;
    };
    await withApp({}, async (other) => {
      expect(await hammer(other, '203.0.113.1')).toBe(429);
      expect((await other.inject({ url: '/rewards/summary', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': '203.0.113.2' } })).statusCode).toBe(200);
    }, { trustedProxyHops: 1 });
    await withApp({}, async (other) => {
      // Untrusted: a forged header changes nothing; everyone behind the proxy is one address.
      expect(await hammer(other, '203.0.113.1')).toBe(429);
      expect((await other.inject({ url: '/rewards/summary', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': '203.0.113.2' } })).statusCode).toBe(429);
    });
  });
});

describe('durable world identity', () => {
  const maybeIdentity = url ? it : it.skip;
  maybeIdentity('is kept across restarts and replaced when a new world is founded', async () => {
    const identityPool = createPool(url!);
    const options = { pool: identityPool, seed: 5, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      initialAgents: { sambar: 1 }, minPopulation: {}, landscape: null };
    try {
      await migrate(identityPool);
      await identityPool.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
      const first = new SimHost(options); await first.boot(); const founded = first.worldId; await first.abort();
      expect(founded).toMatch(/^[0-9a-f-]{36}$/);
      const restarted = new SimHost(options); expect((await restarted.boot()).restoredFrom).not.toBeNull();
      expect(restarted.worldId).toBe(founded); await restarted.abort();
      await identityPool.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
      const refounded = new SimHost(options); await refounded.boot();
      expect(refounded.worldId).not.toBe(founded); await refounded.abort();
    } finally { await identityPool.end(); }
  });
});

