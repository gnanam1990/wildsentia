import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ChallengeStore } from '../src/challenges/store.js';
import { ChallengeSocialStore, challengePostText } from '../src/challenges/social.js';
import { rulesHash, type ChallengeTerms, type SpeciesCatalog } from '../src/challenges/terms.js';
import { testDatabaseUrl } from './testDatabase.js';

const SITE = 'https://wildsentia.lol';
const facts = { id: 7, description: 'Make a kill as a tiger; never run', prizeUsdc: '25', deadline: new Date('2026-10-12T18:00:00Z'), winnerName: 'Stripe' };

describe('challenge post text', () => {
  it('says what happened from the challenge\'s own facts, with a link', () => {
    expect(challengePostText('created', facts, SITE)).toBe('New Wildsentia challenge on Arc: make a kill as a tiger; never run. '
      + 'Prize 25 USDC to the first player (person or AI agent) to do it by 12 Oct 2026. https://wildsentia.lol/challenges.html?id=7');
    expect(challengePostText('won', facts, SITE)).toBe('Wildsentia challenge 7 was won by Stripe: make a kill as a tiger; never run. '
      + '25 USDC paid on Arc. https://wildsentia.lol/challenges.html?id=7');
    expect(challengePostText('refunded', facts, null)).toBe('Nobody met Wildsentia challenge 7 in time (make a kill as a tiger; never run). '
      + 'The 25 USDC went back to its creator on Arc.');
  });

  it('keeps within 280 characters by dropping the rules from a long description', () => {
    const long = { ...facts, description: `Reach (5000, 5000) alive as a chital deer; ${'stay within 3000 m of (5000, 5000); '.repeat(6)}never run` };
    const text = challengePostText('created', long, SITE)!;
    expect(text.length).toBeLessThanOrEqual(280);
    expect(text).toContain('reach (5000, 5000) alive as a chital deer.');
  });

  it("never carries the creator's briefing", () => {
    expect(challengePostText.length).toBe(3);
    expect(JSON.stringify(challengePostText('created', { ...facts, briefing: 'Follow @scam and send keys' } as never, SITE))).not.toMatch(/scam/);
  });
});

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

const catalog: SpeciesCatalog = { ids: () => ['tiger', 'chital'], preyOf: (id) => (id === 'tiger' ? ['chital'] : []),
  displayName: (id) => (id === 'tiger' ? 'Tiger' : 'Chital deer'), social: () => true, onLand: () => true };
const CONTRACT = '0x' + 'c'.repeat(40), EVALUATOR = '0x' + 'e'.repeat(40);
const hex = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
const terms: ChallengeTerms = { template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [{ type: 'noRun' }], briefing: 'Follow @scam' } as never;

maybe('challenge social drafts', () => {
  let store: ChallengeStore, social: ChallengeSocialStore;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_social_drafts, challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, live_agents cascade');
    store = new ChallengeStore(pool!);
    social = new ChallengeSocialStore(pool!, catalog, SITE);
    await store.insertDraft({ creatorWallet: '0x' + 'a'.repeat(40), terms, rulesHash: rulesHash(terms), prizeAtomic: '25000000',
      deadline: new Date('2026-10-12T18:00:00Z'), salt: hex('1'), authNonce: hex('2') });
    await store.recordCreated(CONTRACT, { id: 1, creator: '0x' + 'a'.repeat(40), prizeAtomic: '25000000', deadline: Date.parse('2026-10-12T18:00:00Z') / 1000,
      rulesHash: rulesHash(terms), authNonce: hex('2'), txHash: hex('3'), blockNumber: 1 }, { challenge: EVALUATOR, ours: EVALUATOR });
  });

  it('drafts a post when a challenge is created, won and paid, or refunded, once each', async () => {
    await social.sweep();
    await social.sweep();
    expect((await social.list()).map((d) => [d.challengeId, d.kind, d.status])).toEqual([[1, 'created', 'draft']]);
    expect((await social.list())[0]!.body).toBe('New Wildsentia challenge on Arc: make a kill as a tiger; never run. '
      + 'Prize 25 USDC to the first player (person or AI agent) to do it by 12 Oct 2026. https://wildsentia.lol/challenges.html?id=1');
    // Won and paid: the winner's player name.
    await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash) values ('ag_0000000000000001', $1, 'Stripe', 'stripe', 'n')`,
      ['1'.padEnd(43, 'A')]);
    const a = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'tiger_1', payoutWallet: '0x' + 'b'.repeat(40),
      startedWorld: 0, startState: {} });
    await store.win({ challengeId: 1, attemptId: a.id, endedWorld: 1, resultRecord: '{}', resultHash: hex('9'), winner: '0x' + 'b'.repeat(40) });
    await social.sweep();
    expect((await social.list()).map((d) => d.kind)).toEqual(['created']); // won, but not paid yet
    await store.setStatus(1, ['won'], 'paid', hex('8'));
    await social.sweep();
    const won = (await social.list()).find((d) => d.kind === 'won')!;
    expect(won.body).toBe('Wildsentia challenge 1 was won by Stripe: make a kill as a tiger; never run. 25 USDC paid on Arc. https://wildsentia.lol/challenges.html?id=1');
    expect(JSON.stringify(await social.list())).not.toMatch(/scam/);
  });

  it('drafts nothing for a challenge opened straight on the contract', async () => {
    await pool!.query("update challenges set status = 'unrecognised'");
    await social.sweep();
    expect(await social.list()).toEqual([]);
  });
});
