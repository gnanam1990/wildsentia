import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ChallengeStore, type CreatedEvent, type SettledEvent } from '../src/challenges/store.js';
import { ChallengeIndexer, INDEX_LAG_BLOCKS } from '../src/challenges/indexer.js';
import type { ChallengeChain } from '../src/challenges/chain.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

type Hex = `0x${string}`;
const CONTRACT = ('0x' + 'c'.repeat(40)) as Hex, EVALUATOR = ('0x' + 'e'.repeat(40)) as Hex;
const event = (id: number, blockNumber: number): CreatedEvent => ({ id, creator: '0x' + 'a'.repeat(40), prizeAtomic: '1', deadline: 1,
  rulesHash: `0x${'1'.repeat(64)}`, authNonce: `0x${'0'.repeat(64)}`, txHash: `0x${String(id).repeat(64).slice(0, 64)}`, blockNumber });

/** A chain whose RPC node may lag: it reports the head but can return no logs for the newest blocks. */
class LaggingChain {
  readonly contract = CONTRACT; readonly evaluator = EVALUATOR; readonly chainId = 1;
  headBlock = 100; created: CreatedEvent[] = []; laggingUntil = 0;
  settled: Array<SettledEvent & { blockNumber: number }> = [];
  async head() { return this.headBlock; }
  async events(from: number, to: number) {
    const seen = (e: { blockNumber: number }) => e.blockNumber >= from && e.blockNumber <= to && e.blockNumber > this.laggingUntil;
    return { created: this.created.filter(seen), settled: this.settled.filter(seen).map(({ blockNumber: _, ...e }) => e) };
  }
  async status() { return { status: 'open' as const, evaluator: EVALUATOR, winner: ('0x' + '0'.repeat(40)) as Hex, prize: 1n }; }
  async challengeCount(atBlock: number) { return this.created.filter((e) => e.blockNumber <= atBlock).length; }
}

maybe('challenge indexer', () => {
  let store: ChallengeStore, chain: LaggingChain, indexer: ChallengeIndexer;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor cascade');
    store = new ChallengeStore(pool!);
    chain = new LaggingChain();
    indexer = new ChallengeIndexer(store, chain as unknown as ChallengeChain, 0);
  });

  it('reads only up to a few blocks behind the head', async () => {
    chain.created = [event(1, 50), event(2, 99)];
    expect(await indexer.pollOnce()).toBe(1);
    expect(await store.cursor(CONTRACT)).toBe(100 - INDEX_LAG_BLOCKS + 1);
    chain.headBlock = 120;
    expect(await indexer.pollOnce()).toBe(1);
    expect((await store.challenge(2))!.evaluator).toBe(EVALUATOR.toLowerCase());
  });

  it('reads again from the start when the contract has more challenges than it indexed', async () => {
    chain.created = [event(1, 50)];
    chain.laggingUntil = 60; // the node answering getLogs had not reached block 50 yet
    expect(await indexer.pollOnce()).toBe(0);
    chain.laggingUntil = 0;
    chain.headBlock = 200;
    await indexer.pollOnce(); // notices the gap and rewinds
    await indexer.pollOnce();
    expect((await store.challenge(1))).not.toBeNull();
  });

  it('backfills an interior missing event across polls and a restart, even with the highest ID present', async () => {
    chain.created = [event(1, 50), event(2, 51), event(3, 52), event(4, 53), event(5, 54)];
    const events = chain.events.bind(chain);
    chain.events = async (from, to) => {
      const found = await events(from, to);
      return { ...found, created: found.created.filter(e => e.id !== 2 && e.id !== 4) };
    };
    await indexer.pollOnce();
    expect(await store.maxChallengeId(CONTRACT)).toBe(5);
    expect(await store.indexedChallengeCount(CONTRACT, 5)).toBe(3);
    expect(await store.cursor(CONTRACT)).toBe(0);
    // An omission persisting across a second poll must keep recovery available.
    await indexer.pollOnce();
    expect(await store.cursor(CONTRACT)).toBe(0);
    chain.events = events;
    const restarted = new ChallengeIndexer(store, chain as unknown as ChallengeChain, 0);
    await restarted.pollOnce();
    expect(await store.indexedChallengeCount(CONTRACT, 5)).toBe(5);
    expect(await store.cursor(CONTRACT)).toBe(98);
    expect((await store.challenge(2))!.status).toBe('unrecognised');
    expect((await store.challenge(4))!.status).toBe('unrecognised');
  });

  it('records the transaction that settled each challenge, whoever sent it', async () => {
    chain.created = [event(1, 50), event(2, 51)];
    chain.settled = [{ id: 1, kind: 'resolved', txHash: `0x${'9'.repeat(64)}`, blockNumber: 60 }];
    await indexer.pollOnce();
    expect((await store.challenge(1))!.settledTx).toBe(`0x${'9'.repeat(64)}`);
    // One the server already recorded is kept as it is.
    await pool!.query(`update challenges set settled_tx = $1 where id = 2`, [`0x${'8'.repeat(64)}`]);
    await store.resetCursor(CONTRACT, 0);
    chain.settled.push({ id: 2, kind: 'refunded', txHash: `0x${'7'.repeat(64)}`, blockNumber: 70 });
    await indexer.pollOnce();
    expect((await store.challenge(2))!.settledTx).toBe(`0x${'8'.repeat(64)}`);
  });
});
