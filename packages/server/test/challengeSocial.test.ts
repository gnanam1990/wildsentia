import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { installSocialOutbox } from '../src/socialOutbox.js';
import { installChallengeSocial } from '../src/challenges/socialRoutes.js';
import type { XPublisher } from '../src/xPublisher.js';
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
    social = new ChallengeSocialStore(pool!, catalog, SITE, EVALUATOR);
    await store.insertDraft({ creatorWallet: '0x' + 'a'.repeat(40), terms, rulesHash: rulesHash(terms), prizeAtomic: '25000000',
      deadline: new Date('2030-10-12T18:00:00Z'), salt: hex('1'), authNonce: hex('2') });
    await store.recordCreated(CONTRACT, { id: 1, creator: '0x' + 'a'.repeat(40), prizeAtomic: '25000000', deadline: Date.parse('2030-10-12T18:00:00Z') / 1000,
      rulesHash: rulesHash(terms), authNonce: hex('2'), txHash: hex('3'), blockNumber: 1 }, { challenge: EVALUATOR, ours: EVALUATOR });
  });

  it('drafts a post when a challenge is created, won and paid, or refunded, once each', async () => {
    await social.sweep();
    await social.sweep();
    expect((await social.list()).map((d) => [d.challengeId, d.kind, d.status])).toEqual([[1, 'created', 'draft']]);
    expect((await social.list())[0]!.body).toBe('New Wildsentia challenge on Arc: make a kill as a tiger; never run. '
      + 'Prize 25 USDC to the first player (person or AI agent) to do it by 12 Oct 2030. https://wildsentia.lol/challenges.html?id=1');
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

  describe('admin routes', () => {
    const TOKEN = 'social-admin-token-'.repeat(3);
    let app: FastifyInstance, posted: string[], fail: boolean, known: Map<string, { id: string; text: string; authorId: string }>;
    const publisher: XPublisher = { accountId: '42', verifyAccount: async () => undefined,
      create: async (text) => { posted.push(text); if (fail) throw new Error('timeout'); return { id: String(1000 + posted.length), text }; },
      lookup: async (id) => known.get(id) ?? null };
    beforeEach(async () => {
      posted = []; fail = false; known = new Map();
      app = Fastify();
      installSocialOutbox(app, { pool: pool!, config: { adminToken: TOKEN, xPublisher: publisher }, boundary: () => null });
      installChallengeSocial(app, { social, publisher });
      await app.ready();
      await social.sweep();
    });
    const call = (method: 'GET' | 'POST', path: string, body?: object, token = TOKEN) => app.inject({ method, url: path,
      headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
    const first = async () => (await call('GET', '/admin/social/challenges')).json().drafts[0];

    it('is for the owner only', async () => {
      expect((await call('GET', '/admin/social/challenges', undefined, 'wrong')).statusCode).toBe(401);
      expect((await first())).toMatchObject({ challengeId: 1, kind: 'created', status: 'draft', stillTrue: true });
    });

    it('publishes only approved text that still matches the challenge', async () => {
      const d = await first();
      expect((await call('POST', `/admin/social/challenges/${d.id}/publish`)).json()).toEqual({ error: 'not_approved' });
      expect((await call('POST', `/admin/social/challenges/${d.id}/review`, { action: 'approve', note: 'ok' })).json()).toMatchObject({ status: 'approved' });
      // The facts changed since approval (the prize limit was edited by hand): it no longer says what is true.
      await pool!.query("update challenge_social_drafts set body = body || ' extra' where id = $1", [d.id]);
      expect((await call('POST', `/admin/social/challenges/${d.id}/publish`)).json()).toEqual({ error: 'no_longer_true' });
      expect(posted).toEqual([]);
    });

    it('publishes once: a second press, or an unknown result, never posts again', async () => {
      const d = await first();
      await call('POST', `/admin/social/challenges/${d.id}/review`, { action: 'approve' });
      const done = await call('POST', `/admin/social/challenges/${d.id}/publish`);
      expect(done.json()).toMatchObject({ status: 'published', xPostId: '1001' });
      expect((await call('POST', `/admin/social/challenges/${d.id}/publish`)).json()).toMatchObject({ status: 'published', xPostId: '1001' });
      expect(posted).toHaveLength(1);
      // Another draft whose call to X times out: unknown, and never sent again.
      await store.setStatus(1, ['open'], 'refunding'); await store.setStatus(1, ['refunding'], 'refunded', hex('7'));
      await social.sweep();
      const refunded = (await call('GET', '/admin/social/challenges')).json().drafts.find((x: { kind: string }) => x.kind === 'refunded');
      await call('POST', `/admin/social/challenges/${refunded.id}/review`, { action: 'approve' });
      fail = true;
      expect((await call('POST', `/admin/social/challenges/${refunded.id}/publish`)).json()).toMatchObject({ status: 'unknown' });
      fail = false;
      expect((await call('POST', `/admin/social/challenges/${refunded.id}/publish`)).json()).toEqual({ error: 'not_approved' });
      expect(posted).toHaveLength(2);
      // The owner checks X: a post id is confirmed only if it is ours and says exactly the draft.
      known.set('555', { id: '555', text: 'something else', authorId: '42' });
      expect((await call('POST', `/admin/social/challenges/${refunded.id}/resolve`, { xPostId: '555' })).json()).toEqual({ error: 'post_does_not_match' });
      known.set('556', { id: '556', text: refunded.body, authorId: '42' });
      expect((await call('POST', `/admin/social/challenges/${refunded.id}/resolve`, { xPostId: '556' })).json()).toMatchObject({ status: 'published', xPostId: '556' });
    });

    it('lets the owner say an unknown post never appeared, which makes it publishable again', async () => {
      const d = await first();
      await call('POST', `/admin/social/challenges/${d.id}/review`, { action: 'approve' });
      fail = true;
      await call('POST', `/admin/social/challenges/${d.id}/publish`);
      expect((await call('POST', `/admin/social/challenges/${d.id}/resolve`, {})).json()).toEqual({ error: 'say_what_you_found' });
      expect((await call('POST', `/admin/social/challenges/${d.id}/resolve`, { notPosted: true })).json()).toMatchObject({ status: 'approved' });
    });

    it('rejects and revokes', async () => {
      const d = await first();
      expect((await call('POST', `/admin/social/challenges/${d.id}/review`, { action: 'reject' })).json()).toMatchObject({ status: 'rejected' });
      expect((await call('POST', `/admin/social/challenges/${d.id}/review`, { action: 'approve' })).json()).toMatchObject({ status: 'approved' });
      expect((await call('POST', `/admin/social/challenges/${d.id}/review`, { action: 'revoke' })).json()).toMatchObject({ status: 'revoked' });
      expect((await call('POST', `/admin/social/challenges/${d.id}/review`, { action: 'post' })).statusCode).toBe(400);
      expect((await call('POST', '/admin/social/challenges/nope/review', { action: 'approve' })).statusCode).toBe(404);
    });
  });

  describe('review fixes', () => {
    const TOKEN = 'social-admin-token-'.repeat(3);
    let app: FastifyInstance, posted: string[], fail: boolean;
    const publisher: XPublisher = { accountId: '42', verifyAccount: async () => undefined,
      create: async (text) => { posted.push(text); if (fail) throw new Error('timeout'); return { id: String(2000 + posted.length), text }; },
      lookup: async (id) => (id === '777' ? { id, text: 'Nobody met Wildsentia challenge 1 in time (make a kill as a tiger; never run). The 25 USDC went back to its creator on Arc. https://t.co/xyz', authorId: '42' } : null) };
    beforeEach(async () => {
      posted = []; fail = false;
      app = Fastify();
      installSocialOutbox(app, { pool: pool!, config: { adminToken: TOKEN, xPublisher: publisher }, boundary: () => null });
      installChallengeSocial(app, { social, publisher });
      await app.ready();
    });
    const call = (method: 'GET' | 'POST', path: string, body?: object) => app.inject({ method, url: path,
      headers: { authorization: `Bearer ${TOKEN}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
    const drafts = async () => (await call('GET', '/admin/social/challenges')).json().drafts as Array<{ id: string; kind: string; status: string; body: string; stillTrue: boolean }>;
    const refund = async () => { await store.setStatus(1, ['open', 'won', 'unpaid'], 'refunding'); await store.setStatus(1, ['refunding'], 'refunded', hex('7')); };

    it('confirms a post X shows with its link rewritten to t.co', async () => {
      await refund(); await social.sweep();
      const r = (await drafts()).find((d) => d.kind === 'refunded')!;
      await call('POST', `/admin/social/challenges/${r.id}/review`, { action: 'approve' });
      fail = true;
      await call('POST', `/admin/social/challenges/${r.id}/publish`);
      expect((await call('POST', `/admin/social/challenges/${r.id}/resolve`, { xPostId: '777' })).json()).toMatchObject({ status: 'published', xPostId: '777' });
    });

    it('never posts a "new challenge" once it is no longer open', async () => {
      await social.sweep();
      const c = (await drafts())[0]!;
      await call('POST', `/admin/social/challenges/${c.id}/review`, { action: 'approve' });
      await refund();
      expect((await call('POST', `/admin/social/challenges/${c.id}/publish`)).json()).toEqual({ error: 'no_longer_true' });
      expect(posted).toEqual([]);
      // A challenge already over is never drafted as new.
      await pool!.query('truncate challenge_social_drafts cascade');
      await social.sweep();
      expect((await drafts()).map((d) => d.kind)).toEqual(['refunded']);
    });

    it('says a challenge was met but not paid when its winner could not be paid, not that nobody met it', async () => {
      await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash) values ('ag_0000000000000001', $1, 'Stripe', 'stripe', 'n')`, ['1'.padEnd(43, 'A')]);
      const a = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'tiger_1', payoutWallet: '0x' + 'b'.repeat(40), startedWorld: 0, startState: {} });
      await store.win({ challengeId: 1, attemptId: a.id, endedWorld: 1, resultRecord: '{}', resultHash: hex('9'), winner: '0x' + 'b'.repeat(40) });
      await store.setStatus(1, ['won'], 'unpaid');
      await refund(); await social.sweep();
      expect((await drafts()).find((d) => d.kind === 'refunded')!.body).toBe('Wildsentia challenge 1 was met by Stripe, but the prize could not be paid, '
        + 'so the 25 USDC went back to its creator on Arc. https://wildsentia.lol/challenges.html?id=1');
    });

    it('lets the owner settle a post stuck while being posted, once the X call is long over', async () => {
      await social.sweep();
      const c = (await drafts())[0]!;
      await pool!.query("update challenge_social_drafts set status = 'publishing', reserved_at = now() where id = $1", [c.id]);
      expect((await drafts())[0]!.status).toBe('publishing');
      expect((await call('POST', `/admin/social/challenges/${c.id}/resolve`, { notPosted: true })).json()).toEqual({ error: 'not_unknown' });
      await pool!.query("update challenge_social_drafts set reserved_at = now() - interval '3 minutes' where id = $1", [c.id]);
      expect((await drafts())[0]!.status).toBe('unknown');
      expect((await call('POST', `/admin/social/challenges/${c.id}/resolve`, { notPosted: true })).json()).toMatchObject({ status: 'approved' });
    });

    it('redrafts a post whose challenge facts changed, back to review', async () => {
      await social.sweep();
      const c = (await drafts())[0]!;
      await pool!.query("update challenge_social_drafts set body = 'Old wording' where id = $1", [c.id]);
      expect((await call('POST', `/admin/social/challenges/${c.id}/review`, { action: 'redraft' })).json()).toMatchObject({ status: 'draft', body: c.body });
      expect((await call('POST', `/admin/social/challenges/${c.id}/review`, { action: 'redraft' })).json()).toEqual({ error: 'already_true' });
    });

    it('drafts nothing for a challenge of another evaluator, whatever its status became', async () => {
      await pool!.query("update challenges set evaluator = $1, status = 'refunded'", ['0x' + 'f'.repeat(40)]);
      await social.sweep();
      expect(await drafts()).toEqual([]);
    });

    it('keeps an audit of every step', async () => {
      await social.sweep();
      const c = (await drafts())[0]!;
      await call('POST', `/admin/social/challenges/${c.id}/review`, { action: 'approve', note: 'fine' });
      fail = true;
      await call('POST', `/admin/social/challenges/${c.id}/publish`);
      await call('POST', `/admin/social/challenges/${c.id}/resolve`, { notPosted: true });
      const { rows } = await pool!.query('select action, note from challenge_social_audit where draft_id = $1 order by id', [c.id]);
      expect(rows.map((r) => r.action)).toEqual(['drafted', 'approved', 'reserved', 'unknown', 'resolved_not_posted']);
    });
  });
});
