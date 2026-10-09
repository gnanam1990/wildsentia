import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ChallengeStore, type CreatedEvent } from '../src/challenges/store.js';
import { rulesHash, type ChallengeTerms } from '../src/challenges/terms.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

const EVALUATOR = '0x' + 'e'.repeat(40), OURS = { challenge: EVALUATOR, ours: EVALUATOR };
const CONTRACT = '0x' + 'c'.repeat(40), CREATOR = '0x' + 'a'.repeat(40), WINNER = '0x' + 'b'.repeat(40);
const hex = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
const terms: ChallengeTerms = { template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' };

maybe('challenge store', () => {
  let store: ChallengeStore;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor, live_agents cascade');
    for (const id of ['ag_0000000000000001', 'ag_0000000000000002']) {
      await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash) values ($1, $2, $1, $1, 'n')`,
        [id, id.replace('ag_', '').padEnd(43, 'A')]);
    }
    store = new ChallengeStore(pool!);
  });

  const draftFor = (nonce: string) => store.insertDraft({ creatorWallet: CREATOR, terms, rulesHash: rulesHash(terms), prizeAtomic: '10000000',
    deadline: new Date('2026-10-20T00:00:00Z'), salt: hex('1'), authNonce: hex(nonce) });
  const created = (id: number, authNonce: `0x${string}`, over: Partial<CreatedEvent> = {}): CreatedEvent => ({ id, creator: CREATOR,
    prizeAtomic: '10000000', deadline: Date.parse('2026-10-20T00:00:00Z') / 1000, rulesHash: rulesHash(terms), authNonce,
    txHash: hex(String(id)), blockNumber: 100 + id, ...over });

  it('matches a created challenge to its draft by nonce, once, and marks unknown ones unrecognised', async () => {
    const d = await draftFor('2');
    const c = await store.recordCreated(CONTRACT, created(1, hex('2')), OURS);
    expect(c).toMatchObject({ id: 1, draftId: d.id, status: 'open', terms, prizeAtomic: '10000000', creatorWallet: CREATOR });
    expect(c.deadline.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect((await store.draft(d.id))!.relayedAt).not.toBeNull();
    // The same event read twice changes nothing.
    expect(await store.recordCreated(CONTRACT, created(1, hex('2')), OURS)).toEqual(c);
    // A challenge opened with `create` (zero nonce), or whose terms do not match its draft, is not ours to judge.
    expect((await store.recordCreated(CONTRACT, created(2, hex('0')), OURS)).status).toBe('unrecognised');
    await draftFor('3');
    expect((await store.recordCreated(CONTRACT, created(3, hex('3'), { prizeAtomic: '99000000' }), OURS)).status).toBe('unrecognised');
  });

  it('leaves unplayable a challenge whose own evaluator is not ours', async () => {
    await draftFor('4');
    const c = await store.recordCreated(CONTRACT, created(4, hex('4')), { challenge: '0x' + 'f'.repeat(40), ours: EVALUATOR });
    expect(c).toMatchObject({ status: 'unrecognised', evaluator: '0x' + 'f'.repeat(40) });
  });

  it('turns open challenges of an old evaluator unrecognised, and names other contracts in the database', async () => {
    await draftFor('2');
    await store.recordCreated(CONTRACT, created(1, hex('2')), OURS);
    expect(await store.otherContracts(CONTRACT)).toEqual([]);
    expect(await store.unrecogniseOtherEvaluators(CONTRACT, '0x' + 'f'.repeat(40))).toBe(1);
    expect((await store.challenge(1))!.status).toBe('unrecognised');
    await store.setCursor('0x' + 'd'.repeat(40), 5);
    expect(await store.otherContracts(CONTRACT)).toEqual(['0x' + 'd'.repeat(40)]);
    expect(await store.maxChallengeId(CONTRACT)).toBe(1);
  });

  it('keeps the indexer cursor moving forward only', async () => {
    expect(await store.cursor(CONTRACT)).toBeNull();
    await store.setCursor(CONTRACT, 50);
    await store.setCursor(CONTRACT, 40);
    expect(await store.cursor(CONTRACT)).toBe(50);
  });

  it('lets one running attempt per agent, and only the first goal met wins', async () => {
    await draftFor('2');
    await store.recordCreated(CONTRACT, created(1, hex('2')), OURS);
    const a = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'tiger_1', payoutWallet: WINNER,
      startedWorld: 3600, startState: { x: 1 } });
    await expect(store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'tiger_2', payoutWallet: WINNER,
      startedWorld: 3600, startState: {} })).rejects.toThrow();
    const b = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000002', animalId: 'tiger_3', payoutWallet: WINNER,
      startedWorld: 3600, startState: {} });
    expect(await store.win({ challengeId: 1, attemptId: a.id, endedWorld: 7200, resultRecord: '{}', resultHash: hex('e'), winner: WINNER })).toBe(true);
    expect(await store.win({ challengeId: 1, attemptId: b.id, endedWorld: 7300, resultRecord: '{}', resultHash: hex('f'), winner: WINNER })).toBe(false);
    expect((await store.challenge(1))).toMatchObject({ status: 'won', winnerAttempt: a.id });
    expect((await store.attempt(a.id))).toMatchObject({ status: 'met', resultHash: hex('e'), endReason: 'goal_met' });
    expect((await store.attempt(b.id))).toMatchObject({ status: 'void', endReason: 'challenge_won' });
    const ops = await store.opsOf({ challengeId: 1 });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'resolve', status: 'pending', payload: { winner: WINNER, resultHash: hex('e'), attemptId: a.id } });
  });

  it('keeps an ordered log per attempt', async () => {
    await draftFor('2');
    await store.recordCreated(CONTRACT, created(1, hex('2')), OURS);
    const a = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'tiger_1', payoutWallet: WINNER,
      startedWorld: 0, startState: {} });
    await store.appendLog(a.id, [{ at: new Date(1000), kind: 'start', data: { animalId: 'tiger_1' } },
      { at: new Date(2000), kind: 'command', data: { command: 'hunt' } }]);
    await store.appendLog(a.id, [{ at: new Date(3000), kind: 'hunt', data: { killed: true } }]);
    expect((await store.log(a.id)).map((e) => e.kind)).toEqual(['start', 'command', 'hunt']);
  });

  it('allows one live operation per kind and challenge, and a new one after a failure', async () => {
    await draftFor('2');
    await store.recordCreated(CONTRACT, created(1, hex('2')), OURS);
    expect(await store.enqueueOp('refund', { challengeId: 1 }, {})).toBe(true);
    expect(await store.enqueueOp('refund', { challengeId: 1 }, {})).toBe(false);
    const [first] = await store.activeOps();
    await store.markOpSent(first!.id, hex('d'), 3, 20_000_000_000n);
    expect((await store.activeOps())[0]).toMatchObject({ status: 'sent', txHash: hex('d'), tries: 0, sentNonce: 3, sentMaxFee: '20000000000' });
    await store.markOpFailed(first!.id, 'reverted');
    expect(await store.enqueueOp('refund', { challengeId: 1 }, {})).toBe(true);
  });

  it('finds open challenges whose deadline and grace have passed', async () => {
    await draftFor('2');
    await store.recordCreated(CONTRACT, created(1, hex('2')), OURS);
    const deadline = Date.parse('2026-10-20T00:00:00Z');
    expect(await store.dueRefunds(new Date(deadline + 3600_000), 3600)).toHaveLength(0);
    expect((await store.dueRefunds(new Date(deadline + 3600_001), 3600)).map((c) => c.id)).toEqual([1]);
  });
});
