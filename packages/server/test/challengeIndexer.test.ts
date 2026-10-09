import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ChallengeStore, type CreatedEvent } from '../src/challenges/store.js';
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
  headBlock = 100; events: CreatedEvent[] = []; laggingUntil = 0;
  async head() { return this.headBlock; }
  async createdEvents(from: number, to: number) {
    return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to && e.blockNumber > this.laggingUntil);
  }
  async status() { return { status: 'open' as const, evaluator: EVALUATOR, winner: ('0x' + '0'.repeat(40)) as Hex, prize: 1n }; }
  async challengeCount(atBlock: number) { return this.events.filter((e) => e.blockNumber <= atBlock).length; }
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
    chain.events = [event(1, 50), event(2, 99)];
    expect(await indexer.pollOnce()).toBe(1);
    expect(await store.cursor(CONTRACT)).toBe(100 - INDEX_LAG_BLOCKS + 1);
    chain.headBlock = 120;
    expect(await indexer.pollOnce()).toBe(1);
    expect((await store.challenge(2))!.evaluator).toBe(EVALUATOR.toLowerCase());
  });

  it('reads again from the start when the contract has more challenges than it indexed', async () => {
    chain.events = [event(1, 50)];
    chain.laggingUntil = 60; // the node answering getLogs had not reached block 50 yet
    expect(await indexer.pollOnce()).toBe(0);
    chain.laggingUntil = 0;
    chain.headBlock = 200;
    await indexer.pollOnce(); // notices the gap and rewinds
    await indexer.pollOnce();
    expect((await store.challenge(1))).not.toBeNull();
  });
});
