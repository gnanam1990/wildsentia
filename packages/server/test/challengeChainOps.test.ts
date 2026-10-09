import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ChallengeStore } from '../src/challenges/store.js';
import { ChainOps, DROPPED_AFTER_MS, MAX_TRIES } from '../src/challenges/chainOps.js';
import type { ChainCall, ChallengeChain, OnChainStatus } from '../src/challenges/chain.js';
import { rulesHash, type ChallengeTerms } from '../src/challenges/terms.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

type Hex = `0x${string}`;
const CONTRACT = '0x' + 'c'.repeat(40) as Hex, CREATOR = '0x' + 'a'.repeat(40), WINNER = '0x' + 'b'.repeat(40) as Hex;
const hex = (c: string) => `0x${c.repeat(64)}` as Hex;
const terms: ChallengeTerms = { template: 'hunt', version: 1, speciesId: 'tiger' };

/** An in-memory contract with switchable failures, standing in for the chain client. */
class FakeChain implements ChallengeChain {
  readonly contract = CONTRACT; readonly evaluator = '0x' + 'e'.repeat(40) as Hex; readonly chainId = 1;
  state = new Map<number, OnChainStatus>();
  sent: ChainCall[] = []; mined = new Map<Hex, 'success' | 'reverted'>(); pool = new Set<Hex>();
  failPrepare: string | null = null; failBroadcast = false; dropNext = false; revertNext = false;
  #n = 0; #calls = new Map<Hex, ChainCall>();
  async head() { return 0; }
  async createdEvents() { return []; }
  async status(id: number) { return { status: this.state.get(id) ?? 'open' as OnChainStatus, evaluator: this.evaluator, winner: WINNER, prize: 1n }; }
  async appointedEvaluator() { return this.evaluator; }
  async prizeLimits() { return { min: 1n, max: 100n }; }
  async prepare(call: ChainCall) {
    if (this.failPrepare) throw new Error(this.failPrepare);
    const raw = `0x${(++this.#n).toString(16).padStart(8, '0')}` as Hex;
    const hash = keccak256(toBytes(raw));
    this.#calls.set(hash, call);
    return { hash, raw };
  }
  async broadcast(raw: Hex) {
    if (this.failBroadcast) { this.failBroadcast = false; throw new Error('rpc down'); }
    const hash = keccak256(toBytes(raw)), call = this.#calls.get(hash)!;
    if (this.dropNext) { this.dropNext = false; return; } // accepted, then lost
    this.sent.push(call); this.pool.add(hash);
    if (this.revertNext) { this.revertNext = false; this.mined.set(hash, 'reverted'); return; }
    this.mined.set(hash, 'success');
    if (call.fn === 'resolve') this.state.set(call.id, 'resolved');
    if (call.fn === 'refund') this.state.set(call.id, 'refunded');
  }
  async receipt(hash: Hex) { return this.mined.get(hash) ?? null; }
  async known(hash: Hex) { return this.pool.has(hash); }
}

maybe('chain operations', () => {
  let store: ChallengeStore, chain: FakeChain, ops: ChainOps, now: number;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor cascade');
    store = new ChallengeStore(pool!);
    await store.insertDraft({ creatorWallet: CREATOR, terms, rulesHash: rulesHash(terms), prizeAtomic: '1', deadline: new Date(),
      salt: hex('1'), authNonce: hex('2') });
    await store.recordCreated(CONTRACT, { id: 1, creator: CREATOR, prizeAtomic: '1', deadline: 1, rulesHash: rulesHash(terms),
      authNonce: hex('2'), txHash: hex('3'), blockNumber: 1 });
    chain = new FakeChain();
    now = Date.now();
    ops = new ChainOps(store, chain, () => now);
  });
  const op = async () => (await store.opsOf({ challengeId: 1 })).at(-1)!;
  const won = async () => { await pool!.query("update challenges set status = 'won' where id = 1"); };

  it('pays a winner: hash stored, sent, then confirmed and the challenge marked paid', async () => {
    await won();
    await store.enqueueOp('resolve', { challengeId: 1 }, { winner: WINNER, resultHash: hex('e') });
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'sent', tries: 0 });
    expect(chain.sent).toEqual([{ fn: 'resolve', id: 1, winner: WINNER, resultHash: hex('e') }]);
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'confirmed' });
    expect((await store.challenge(1))!).toMatchObject({ status: 'paid', settledTx: (await op()).txHash });
  });

  it('never sends again what the contract already shows done (a crash after sending)', async () => {
    await won();
    await store.enqueueOp('resolve', { challengeId: 1 }, { winner: WINNER, resultHash: hex('e') });
    chain.state.set(1, 'resolved');
    await ops.processOnce();
    expect(chain.sent).toEqual([]);
    expect(await op()).toMatchObject({ status: 'confirmed' });
    expect((await store.challenge(1))!.status).toBe('paid');
  });

  it('retries a broadcast that failed, without counting it as a try', async () => {
    await won();
    await store.enqueueOp('resolve', { challengeId: 1 }, { winner: WINNER, resultHash: hex('e') });
    chain.failBroadcast = true;
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'pending', lastError: 'broadcast: rpc down' });
    await ops.processOnce();
    await ops.processOnce();
    expect((await op()).status).toBe('confirmed');
    expect(chain.sent).toHaveLength(1);
  });

  it('signs again a transaction the node dropped, after a while', async () => {
    await won();
    await store.enqueueOp('resolve', { challengeId: 1 }, { winner: WINNER, resultHash: hex('e') });
    chain.dropNext = true;
    await ops.processOnce();
    await ops.processOnce();
    expect((await op()).status).toBe('sent'); // not yet given up on
    now += DROPPED_AFTER_MS + 1000;
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'pending', lastError: 'dropped' });
    await ops.processOnce();
    await ops.processOnce();
    expect((await op()).status).toBe('confirmed');
  });

  it('marks a winner unpaid when the payout reverts, so the prize refunds', async () => {
    await won();
    await store.enqueueOp('resolve', { challengeId: 1 }, { winner: WINNER, resultHash: hex('e') });
    chain.revertNext = true;
    await ops.processOnce();
    await ops.processOnce();
    expect(await op()).toMatchObject({ status: 'failed', lastError: 'reverted' });
    expect((await store.challenge(1))!.status).toBe('unpaid');
    expect((await store.dueRefunds(new Date(10_000_000_000_000), 3600)).map((c) => c.id)).toEqual([1]);
  });

  it('backs off after a refused transaction and gives up after the last try', async () => {
    await store.enqueueOp('refund', { challengeId: 1 }, {});
    chain.failPrepare = 'execution reverted: TooEarly()';
    for (let i = 0; i < MAX_TRIES + 2; i++) { await ops.processOnce(); now += 10 * 60_000; }
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
