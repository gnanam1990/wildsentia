import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ChallengeStore } from '../src/challenges/store.js';
import { ChainOps, DROPPED_AFTER_MS, MAX_TRIES, RECORDS_PAUSE_MS, STUCK_AFTER_MS } from '../src/challenges/chainOps.js';
import { GRACE_SECONDS } from '../src/challenges/engine.js';
import type { ChainCall, ChallengeChain, OnChainStatus, PrepareOptions } from '../src/challenges/chain.js';
import { rulesHash, type ChallengeTerms } from '../src/challenges/terms.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

type Hex = `0x${string}`;
const CONTRACT = '0x' + 'c'.repeat(40) as Hex, CREATOR = '0x' + 'a'.repeat(40), WINNER = '0x' + 'b'.repeat(40) as Hex;
const EVALUATOR = '0x' + 'e'.repeat(40);
const hex = (c: string) => `0x${c.repeat(64)}` as Hex;
const terms: ChallengeTerms = { template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' };
const GWEI = 1_000_000_000n;

/** An in-memory contract with switchable failures, standing in for the chain client. */
class FakeChain implements ChallengeChain {
  readonly contract = CONTRACT; readonly evaluator = EVALUATOR as Hex; readonly chainId = 1; attempts: Hex | null = ('0x' + 'd'.repeat(40)) as Hex;
  state = new Map<number, OnChainStatus>();
  stages = new Map<string, 0 | 1 | 2>();
  sent: ChainCall[] = []; mined = new Map<Hex, 'success' | 'reverted'>(); pool = new Set<Hex>(); prepared: Array<PrepareOptions | undefined> = [];
  failPrepare: string | null = null; failBroadcast = false; dropNext = false; revertNext = false; stuck = false;
  #n = 0; #nonce = 0; #calls = new Map<Hex, ChainCall>();
  async head() { return 0; }
  async createdEvents() { return []; }
  async status(id: number) { return { status: this.state.get(id) ?? 'open' as OnChainStatus, evaluator: this.evaluator, winner: WINNER, prize: 1n }; }
  async appointedEvaluator() { return this.evaluator; }
  async prizeLimits() { return { min: 1n, max: 100n }; }
  async challengeCount(_atBlock: number) { return this.state.size; }
  async attemptStage(attemptId: string) { return this.stages.get(attemptId) ?? 0; }
  async attemptsRecorder() { return this.evaluator; }
  async prepare(call: ChainCall, options?: PrepareOptions) {
    this.prepared.push(options);
    if (this.failPrepare) throw new Error(this.failPrepare);
    const raw = `0x${(++this.#n).toString(16).padStart(8, '0')}` as Hex;
    const hash = keccak256(toBytes(raw));
    this.#calls.set(hash, call);
    const nonce = options?.nonce ?? this.#nonce++;
    const maxFeePerGas = options?.minMaxFeePerGas && options.minMaxFeePerGas > 20n * GWEI ? options.minMaxFeePerGas : 20n * GWEI;
    return { hash, raw, nonce, maxFeePerGas };
  }
  async broadcast(raw: Hex) {
    if (this.failBroadcast) { this.failBroadcast = false; throw new Error('rpc down'); }
    const hash = keccak256(toBytes(raw)), call = this.#calls.get(hash)!;
    if (this.dropNext) { this.dropNext = false; return; } // accepted, then lost
    this.sent.push(call); this.pool.add(hash);
    if (this.stuck) { this.stuck = false; return; } // waits in the mempool, never mined at this fee
    if (this.revertNext) { this.revertNext = false; this.mined.set(hash, 'reverted'); return; }
    this.mined.set(hash, 'success');
    if (call.fn === 'resolve') this.state.set(call.id, 'resolved');
    if (call.fn === 'refund') this.state.set(call.id, 'refunded');
    if (call.fn === 'recordStart') this.stages.set(call.attemptId, 1);
    if (call.fn === 'recordEnd') this.stages.set(call.attemptId, 2);
  }
  async receipt(hash: Hex) { return this.mined.get(hash) ?? null; }
  async known(hash: Hex) { return this.pool.has(hash); }
}

maybe('chain operations', () => {
  let store: ChallengeStore, chain: FakeChain, ops: ChainOps, now: number;
  const deadline = Date.now() + 86_400_000;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor, live_agents cascade');
    await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash) values ($1, $2, $1, $1, 'n')`,
      ['ag_0000000000000001', '0000000000000001'.padEnd(43, 'A')]);
    store = new ChallengeStore(pool!);
    await store.insertDraft({ creatorWallet: CREATOR, terms, rulesHash: rulesHash(terms), prizeAtomic: '1', deadline: new Date(deadline),
      salt: hex('1'), authNonce: hex('2') });
    await store.recordCreated(CONTRACT, { id: 1, creator: CREATOR, prizeAtomic: '1', deadline: Math.floor(deadline / 1000), rulesHash: rulesHash(terms),
      authNonce: hex('2'), txHash: hex('3'), blockNumber: 1 }, { challenge: EVALUATOR, ours: EVALUATOR });
    chain = new FakeChain();
    now = Date.now();
    ops = new ChainOps(store, chain, () => now);
  });
  const op = async () => (await store.opsOf({ challengeId: 1 })).at(-1)!;
  const won = async () => {
    await pool!.query("update challenges set status = 'won' where id = 1");
    await store.enqueueOp('resolve', { challengeId: 1 }, { winner: WINNER, resultHash: hex('e') });
  };
  /** Moves both clocks: the app's, and the database's view of the op's last update. */
  const later = async (ms: number) => { now += ms; await pool!.query("update challenge_chain_ops set updated_at = updated_at - make_interval(secs => $1)", [ms / 1000]); };

  const recorded = async () => {
    const a = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'chital_1', payoutWallet: WINNER,
      startedWorld: 0, startState: {} });
    const target = { attemptId: a.id, challengeId: 1 };
    await store.enqueueOp('record_start', target, { player: WINNER });
    await store.enqueueOp('record_end', target, { outcome: 2, logHash: hex('9') });
    return a.id;
  };

  it("records an attempt's start and end once, even after a crash", async () => {
    const id = await recorded();
    await ops.processOnce();
    expect(chain.sent).toEqual([{ fn: 'recordStart', attemptId: id, challengeId: 1, player: WINNER }]);
    await ops.processOnce();
    expect(chain.sent.at(-1)).toEqual({ fn: 'recordEnd', attemptId: id, challengeId: 1, outcome: 2, logHash: hex('9') });
    await ops.processOnce();
    expect((await store.opsOf({ attemptId: id })).map((o) => o.status)).toEqual(['confirmed', 'confirmed']);
    // A second attempt whose records the contract already shows (sent before a crash): nothing is sent.
    await pool!.query("update challenge_attempts set status = 'failed', ended_at = now() where id = $1", [id]);
    const again = await recorded();
    chain.stages.set(again, 2);
    const before = chain.sent.length;
    await ops.processOnce();
    expect(chain.sent.length).toBe(before);
    expect((await store.opsOf({ attemptId: again })).map((o) => o.status)).toEqual(['confirmed', 'confirmed']);
  });

  it('pays before recording, and never ends an attempt on chain before its start is recorded', async () => {
    const id = await recorded();
    now = deadline + (GRACE_SECONDS + 600) * 1000;
    await store.enqueueOp('refund', { challengeId: 1 }, {});
    await ops.processOnce();
    // The refund goes first; the end waits while the start is still on its way.
    expect(chain.sent.map((c) => c.fn)).toEqual(['refund', 'recordStart']);
    expect((await store.opsOf({ attemptId: id })).map((o) => o.status)).toEqual(['sent', 'pending']);
    await ops.processOnce();
    expect(chain.sent.map((c) => c.fn)).toEqual(['refund', 'recordStart', 'recordEnd']);
  });

  it('leaves attempt records waiting, untouched, while no attempts contract is set', async () => {
    const id = await recorded();
    chain.attempts = null;
    for (let i = 0; i < 5; i++) await ops.processOnce();
    expect(chain.prepared).toHaveLength(0);
    expect((await store.opsOf({ attemptId: id })).map((o) => [o.status, o.tries])).toEqual([['pending', 0], ['pending', 0]]);
  });

  it('pauses attempt records when the contract no longer takes our key, keeps paying, and tries again later', async () => {
    const id = await recorded();
    await store.enqueueOp('refund', { challengeId: 1 }, {});
    now = deadline + (GRACE_SECONDS + 600) * 1000;
    const prepare = chain.prepare.bind(chain);
    chain.prepare = async (call, options) => {
      if (call.fn === 'recordStart' || call.fn === 'recordEnd') throw new Error('execution reverted: NotRecorder()');
      return prepare(call, options);
    };
    await ops.processOnce();
    await ops.processOnce();
    expect(chain.sent.map((c) => c.fn)).toEqual(['refund']);
    // The record is not given up and no try is counted: the owner may move the recorder back, or restart with the new key.
    expect((await store.opsOf({ attemptId: id })).map((o) => [o.status, o.tries])).toEqual([['pending', 0], ['pending', 0]]);
    const tried = chain.prepared.length;
    await ops.processOnce();
    expect(chain.prepared.length).toBe(tried); // paused: no RPC calls for records
    chain.prepare = prepare;
    now += RECORDS_PAUSE_MS + 1;
    await ops.processOnce();
    expect(chain.sent.map((c) => c.fn)).toEqual(['refund', 'recordStart']);
  });

  it('pays a winner: hash stored, sent, then confirmed and the challenge marked paid', async () => {
    await won();
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'sent', tries: 0, sentNonce: 0 });
    expect(chain.sent).toEqual([{ fn: 'resolve', id: 1, winner: WINNER, resultHash: hex('e') }]);
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'confirmed' });
    expect((await store.challenge(1))!).toMatchObject({ status: 'paid', settledTx: (await op()).txHash });
  });

  it('never sends again what the contract already shows done (a crash after sending)', async () => {
    await won();
    chain.state.set(1, 'resolved');
    await ops.processOnce();
    expect(chain.sent).toEqual([]);
    expect(await op()).toMatchObject({ status: 'confirmed' });
    expect((await store.challenge(1))!.status).toBe('paid');
  });

  it('keeps a transaction it may have sent when the broadcast errors, and signs again only once the node does not know it', async () => {
    await won();
    chain.failBroadcast = true;
    await ops.processOnce();
    const first = await op();
    expect(first).toMatchObject({ status: 'sent', lastError: 'broadcast: rpc down' });
    expect(first.txHash).not.toBeNull();
    await ops.processOnce();
    expect((await op()).status).toBe('sent'); // not yet given up on
    await later(DROPPED_AFTER_MS + 1000);
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'pending', lastError: 'dropped' });
    await ops.processOnce();
    await ops.processOnce();
    expect((await op()).status).toBe('confirmed');
    expect(chain.sent).toHaveLength(1);
  });

  it('signs again a transaction the node dropped, after a while', async () => {
    await won();
    chain.dropNext = true;
    await ops.processOnce();
    await ops.processOnce();
    expect((await op()).status).toBe('sent');
    await later(DROPPED_AFTER_MS + 1000);
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'pending', lastError: 'dropped' });
    await ops.processOnce();
    await ops.processOnce();
    expect((await op()).status).toBe('confirmed');
  });

  it('replaces a stuck transaction at the same nonce with a higher fee', async () => {
    await won();
    chain.stuck = true;
    await ops.processOnce();
    const stuck = await op();
    await ops.processOnce();
    expect((await op()).status).toBe('sent');
    await later(STUCK_AFTER_MS + 1000);
    await ops.processOnce();
    const replaced = await op();
    expect(replaced.txHash).not.toBe(stuck.txHash);
    expect(replaced.sentNonce).toBe(stuck.sentNonce);
    expect(BigInt(replaced.sentMaxFee!)).toBeGreaterThan(BigInt(stuck.sentMaxFee!));
    expect(chain.prepared.at(-1)).toMatchObject({ nonce: stuck.sentNonce });
    await ops.processOnce();
    expect((await op()).status).toBe('confirmed');
  });

  it('keeps retrying a payout through RPC errors and a pause, and gives up only on a permanent refusal', async () => {
    await won();
    for (const error of ['HTTP request failed. Status: 429', 'The request took too long to respond.', 'execution reverted: ResolveIsPaused()']) {
      chain.failPrepare = error;
      for (let i = 0; i < MAX_TRIES + 2; i++) { await ops.processOnce(); await later(30 * 60_000); }
      expect((await op()).status).toBe('pending');
      expect((await store.challenge(1))!.status).toBe('won');
    }
    chain.failPrepare = 'execution reverted: BadWinner()';
    await later(30 * 60_000);
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'failed' });
    expect((await store.challenge(1))!.status).toBe('unpaid');
    expect((await store.dueRefunds(new Date(deadline + 3_600_001 + 120_000), 3600 + 120)).map((c) => c.id)).toEqual([1]);
  });

  it('retries a payout the chain reverted while it can still be paid, and marks it unpaid once the window has closed', async () => {
    await won();
    chain.revertNext = true;
    await ops.processOnce();
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'pending', lastError: 'reverted' });
    expect((await store.challenge(1))!.status).toBe('won');
    now = deadline + GRACE_SECONDS * 1000 + 1;
    await later(60 * 60_000);
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'failed', lastError: 'window_closed' });
    expect((await store.challenge(1))!.status).toBe('unpaid');
  });

  it('backs off after a refused refund, does not count RPC errors, and gives up after the last try', async () => {
    await store.enqueueOp('refund', { challengeId: 1 }, {});
    chain.failPrepare = 'HTTP request failed. Status: 503';
    for (let i = 0; i < MAX_TRIES + 2; i++) { await ops.processOnce(); await later(10 * 60_000); }
    expect(await op()).toMatchObject({ status: 'pending', tries: 0 });
    chain.failPrepare = 'execution reverted: TooEarly()';
    for (let i = 0; i < MAX_TRIES + 2; i++) { await ops.processOnce(); await later(10 * 60_000); }
    expect(await op()).toMatchObject({ status: 'failed' });
    expect((await op()).lastError).toContain('TooEarly');
    expect(chain.sent).toEqual([]);
  });

  it('confirms a relayed creation once the indexer has seen it, and drops an expired authorization', async () => {
    const draft = (await store.insertDraft({ creatorWallet: CREATOR, terms, rulesHash: rulesHash(terms), prizeAtomic: '1',
      deadline: new Date(), salt: hex('4'), authNonce: hex('5') }));
    const payload = { creator: CREATOR, rulesHash: rulesHash(terms), prize: '1', deadline: '1', salt: hex('4'), validAfter: '0',
      validBefore: String(Math.floor(now / 1000) + 600), signature: '0x' + '1'.repeat(130) };
    await store.enqueueOp('relay_create', { draftId: draft.id }, payload);
    await ops.processOnce();
    expect(chain.sent.map((c) => c.fn)).toEqual(['createWithAuthorization']);
    await store.markDraftRelayed(draft.id);
    await ops.processOnce();
    expect((await store.opsOf({ draftId: draft.id }))[0]!.status).toBe('confirmed');

    const late = await store.insertDraft({ creatorWallet: CREATOR, terms, rulesHash: rulesHash(terms), prizeAtomic: '1',
      deadline: new Date(), salt: hex('6'), authNonce: hex('7') });
    await store.enqueueOp('relay_create', { draftId: late.id }, { ...payload, validBefore: String(Math.floor(now / 1000) - 1) });
    await ops.processOnce();
    expect((await store.opsOf({ draftId: late.id }))[0]).toMatchObject({ status: 'failed', lastError: 'authorization_expired' });
  });
});
