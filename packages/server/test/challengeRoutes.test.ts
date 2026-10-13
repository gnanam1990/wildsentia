import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { patchCentre } from '@vana/shared';
import { createWorld } from '@vana/sim';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import type { AcceptResult } from '../src/challenges/engine.js';
import { ChallengeStore } from '../src/challenges/store.js';
import { installChallenges } from '../src/challenges/routes.js';
import { challengesConfig, challengesRuntime, type ChallengesConfig } from '../src/challenges/runtime.js';
import type { ChallengeChain } from '../src/challenges/chain.js';
import { rulesHash, type SpeciesCatalog } from '../src/challenges/terms.js';
import type { DraftConfig } from '../src/challenges/drafts.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { AccountStore } from '../src/accounts/store.js';
import { AgentStore } from '../src/live/liveStore.js';
import { installLiveAgents, walletProofMessage } from '../src/live/routes.js';
import { signingString } from '../src/live/signing.js';
// @ts-expect-error the agent client is plain JavaScript
import { walletMessage } from '../agent-client/client.mjs';
import { testDatabaseUrl } from './testDatabase.js';
import { ISLAND_GRID } from '@vana/shared';

describe('challenges configuration', () => {
  const full = { VANA_CHALLENGES: '1', VANA_LIVE_AGENTS: '1', VANA_CHALLENGES_RPC_URL: 'https://rpc.testnet.arc.io',
    VANA_CHALLENGES_CHAIN_ID: '5042002', VANA_CHALLENGES_CONTRACT: '0x' + '1'.repeat(40), VANA_CHALLENGES_USDC: '0x3600000000000000000000000000000000000000',
    VANA_CHALLENGES_EVALUATOR_KEY: '0x' + 'a'.repeat(64), VANA_CHALLENGES_FROM_BLOCK: '100', VANA_CHALLENGES_ADMIN_TOKEN: 'x'.repeat(40),
    VANA_CHALLENGES_USDC_DOMAIN_NAME: 'USDC', VANA_CHALLENGES_USDC_DOMAIN_VERSION: '2' };
  it('is off unless asked for, and complete when on', () => {
    expect(challengesConfig({})).toBeUndefined();
    expect(challengesConfig({ VANA_CHALLENGES: '0' })).toBeUndefined();
    expect(challengesConfig(full)).toMatchObject({ chainId: 5042002, fromBlock: 100, usdcDomain: { name: 'USDC', version: '2' }, explorerUrl: null,
      attemptsContract: null });
    expect(challengesConfig({ ...full, VANA_CHALLENGES_ATTEMPTS_CONTRACT: '0x' + 'ab'.repeat(20) })!.attemptsContract!.toLowerCase())
      .toBe('0x' + 'ab'.repeat(20));
  });
  it('refuses a partial or unsafe setup', () => {
    expect(() => challengesConfig({ ...full, VANA_LIVE_AGENTS: '0' })).toThrow('VANA_LIVE_AGENTS');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_CONTRACT: '' })).toThrow('VANA_CHALLENGES_CONTRACT');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_RPC_URL: 'http://rpc.example.com' })).toThrow('RPC_URL');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_EVALUATOR_KEY: '0x1234' })).toThrow('EVALUATOR_KEY');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_ADMIN_TOKEN: 'short' })).toThrow('ADMIN_TOKEN');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES: 'yes' })).toThrow('VANA_CHALLENGES');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_ATTEMPTS_CONTRACT: '0x12' })).toThrow('VANA_CHALLENGES_ATTEMPTS_CONTRACT');
    expect(challengesConfig(full)!.siteUrl).toBeNull();
    expect(challengesConfig({ ...full, VANA_PUBLIC_ORIGIN: 'https://wildsentia.lol/' })!.siteUrl).toBe('https://wildsentia.lol');
    expect(() => challengesConfig({ ...full, VANA_PUBLIC_ORIGIN: 'http://wildsentia.lol' })).toThrow('VANA_PUBLIC_ORIGIN');
    expect(() => challengesConfig({ ...full, VANA_PUBLIC_ORIGIN: 'https://wildsentia.lol/x?y' })).toThrow('VANA_PUBLIC_ORIGIN');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_ATTEMPTS_CONTRACT: '0x' + '0'.repeat(40) })).toThrow('VANA_CHALLENGES_ATTEMPTS_CONTRACT');
  });
});

describe('agent client', () => {
  it('asks for the same wallet message the server checks', () => {
    expect(walletMessage('ag_0000000000000001', '0xABCDEF0000000000000000000000000000000001', 'vana:w1'))
      .toBe(walletProofMessage('ag_0000000000000001', '0xABCDEF0000000000000000000000000000000001', 'vana:w1'));
  });
  it('calls the waiting-list and field-guide routes the server serves', async () => {
    const source = readFileSync(fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)), 'utf8');
    expect(source).toContain("call('POST', '/agents/me/challenges/leave')");
    expect(source).toContain('`${BASE}/agents/species');
    expect(source).toMatch(/case 'leave':.*case 'species':/s);
  });
});

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

const catalog: SpeciesCatalog = { ids: () => ['tiger', 'chital'], preyOf: (id) => (id === 'tiger' ? ['chital'] : []),
  displayName: (id) => (id === 'tiger' ? 'Tiger' : 'Chital'), social: (id) => id === 'chital', onLand: () => true };
const drafts: DraftConfig = { chainId: 5042002, contract: ('0x' + '1'.repeat(40)) as `0x${string}`,
  usdc: '0x3600000000000000000000000000000000000000', usdcDomain: { name: 'USDC', version: '2' }, minPrizeAtomic: 1_000_000n, maxPrizeAtomic: 100_000_000n };
const ADMIN = 'challenge-admin-token-'.repeat(2);

maybe('challenge routes', () => {
  let app: FastifyInstance, store: ChallengeStore;
  beforeAll(async () => { await migrate(pool!); });
  beforeEach(async () => {
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor, live_agents cascade');
    store = new ChallengeStore(pool!);
    app = Fastify();
    installChallenges(app, { store, catalog, drafts, adminToken: ADMIN, explorerUrl: 'https://explorer.testnet.arc.io' });
    await app.ready();
  });

  const draft = (body: object, token = ADMIN) => app.inject({ method: 'POST', url: '/challenges/drafts', headers: { authorization: `Bearer ${token}` }, payload: body });

  it('publishes the contract, limits and templates', async () => {
    expect((await app.inject('/challenges/info')).json()).toMatchObject({ chainId: 5042002, contract: drafts.contract,
      prizeUsdc: { min: '1', max: '100' }, explorerUrl: 'https://explorer.testnet.arc.io', templates: { survive: { days: [1, 3, 7, 14] }, hunt: { count: [1, 2, 3, 4, 5] }, reach: { withinM: 25, minStartM: 1000 } },
      rules: { max: 3, zone: { radiusM: { min: 200, max: 3000 } }, herd: { maxDistanceM: { min: 30, max: 200 } } }, briefingMaxChars: 280 });
  });

  it('drafts only for the operator, and returns the typed data to sign', async () => {
    const creator = privateKeyToAccount(generatePrivateKey());
    const body = { creatorWallet: creator.address, terms: { template: 'hunt', speciesId: 'tiger' }, prizeUsdc: '12.5', days: 3 };
    expect((await draft(body, 'wrong-token-'.repeat(4))).statusCode).toBe(401);
    expect((await draft({ ...body, prizeUsdc: '500' })).json()).toEqual({ error: 'bad_prize' });
    expect((await draft({ ...body, terms: { template: 'hunt', speciesId: 'chital' } })).json()).toEqual({ error: 'not_a_hunter' });
    const made = (await draft(body)).json();
    expect(made).toMatchObject({ description: 'Make a kill as a tiger', rulesHash: rulesHash({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' }),
      typedData: { primaryType: 'ReceiveWithAuthorization', domain: { name: 'USDC', version: '2', chainId: 5042002 },
        message: { from: creator.address, to: drafts.contract, value: '12500000', validAfter: '0' } } });

    // Relay: refuses junk and someone else's signature, queues the creator's once.
    const relay = (signature: string) => app.inject({ method: 'POST', url: `/challenges/drafts/${made.draftId}/relay`, payload: { signature } });
    expect((await relay('0x1234')).statusCode).toBe(400);
    const typed = { ...made.typedData, message: { ...made.typedData.message, value: BigInt(made.typedData.message.value),
      validAfter: 0n, validBefore: BigInt(made.typedData.message.validBefore) } };
    const stranger = await privateKeyToAccount(generatePrivateKey()).signTypedData(typed);
    expect((await relay(stranger)).json()).toEqual({ error: 'signature_does_not_match' });
    const signature = await creator.signTypedData(typed);
    expect((await relay(signature)).statusCode).toBe(202);
    expect((await relay(signature)).json()).toEqual({ error: 'already_queued' });
    expect((await store.opsOf({ draftId: made.draftId }))[0]).toMatchObject({ kind: 'relay_create', payload: { signature, prize: '12500000' } });

    // The creator's page follows it: on its way, then failed with a reason, or created with its id.
    const status = async (id = made.draftId) => (await app.inject(`/challenges/drafts/${id}/status`)).json();
    expect(await status()).toEqual({ state: 'sending' });
    const [relayOp] = await store.opsOf({ draftId: made.draftId });
    await store.markOpFailed(relayOp!.id, 'authorization_expired');
    expect(await status()).toEqual({ state: 'failed', error: 'authorization_expired' });
    await pool!.query(`insert into challenges (id, contract, draft_id, creator_wallet, evaluator, terms, rules_hash, prize_atomic, deadline, auth_nonce,
      status, created_tx, created_block) select 7, $2, id, creator_wallet, $3, terms, rules_hash, prize_atomic, deadline, auth_nonce, 'open', $4, 1
      from challenge_drafts where id = $1`, [made.draftId, drafts.contract.toLowerCase(), '0x' + 'e'.repeat(40), `0x${'5'.repeat(64)}`]);
    expect(await status()).toEqual({ state: 'created', challengeId: 7 });
    expect((await app.inject('/challenges/drafts/00000000-0000-4000-8000-000000000000/status')).statusCode).toBe(404);
    expect((await app.inject('/challenges/drafts/not-a-uuid/status')).statusCode).toBe(404);
  });

  it('shows a challenge, its attempts with names, and an attempt log; hides unrecognised ones', async () => {
    const terms = { template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' } as const;
    await store.insertDraft({ creatorWallet: '0x' + 'a'.repeat(40), terms, rulesHash: rulesHash(terms), prizeAtomic: '10000000',
      deadline: new Date('2026-10-20T00:00:00Z'), salt: `0x${'1'.repeat(64)}`, authNonce: `0x${'2'.repeat(64)}` });
    await store.recordCreated(drafts.contract, { id: 1, creator: '0x' + 'a'.repeat(40), prizeAtomic: '10000000', deadline: 1_792_454_400,
      rulesHash: rulesHash(terms), authNonce: `0x${'2'.repeat(64)}`, txHash: `0x${'3'.repeat(64)}`, blockNumber: 5 }, { challenge: '0x' + 'e'.repeat(40), ours: '0x' + 'e'.repeat(40) });
    await store.recordCreated(drafts.contract, { id: 2, creator: '0x' + 'a'.repeat(40), prizeAtomic: '10000000', deadline: 1_792_454_400,
      rulesHash: `0x${'9'.repeat(64)}`, authNonce: `0x${'0'.repeat(64)}`, txHash: `0x${'4'.repeat(64)}`, blockNumber: 6 }, { challenge: '0x' + 'e'.repeat(40), ours: '0x' + 'e'.repeat(40) });
    await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash) values ('ag_0000000000000001', $1, 'Stripe', 'stripe', 'n')`, ['1'.padEnd(43, 'A')]);
    const a = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'tiger_1', payoutWallet: '0x' + 'b'.repeat(40),
      startedWorld: 0, startState: {} });
    await store.appendLog(a.id, [{ at: new Date(0), kind: 'start', data: { animalId: 'tiger_1' } }]);
    const list = (await app.inject('/challenges')).json().challenges;
    expect(list.map((c: { id: number }) => c.id)).toEqual([1]);
    expect(list[0]).toMatchObject({ status: 'open', description: 'Make a kill as a tiger', prizeUsdc: '10', createdTx: `0x${'3'.repeat(64)}`, attemptCount: 1 });
    const one = (await app.inject('/challenges/1')).json();
    expect(one.attempts[0]).toMatchObject({ id: a.id, agentName: 'Stripe', status: 'running' });
    expect((await app.inject(`/challenges/1/attempts/${a.id}`)).json()).toMatchObject({ log: [{ kind: 'start', data: { animalId: 'tiger_1' } }],
      resultHash: null, onChain: [] });
    await store.enqueueOp('record_start', { attemptId: a.id, challengeId: 1 }, { player: '0x' + 'b'.repeat(40) });
    expect((await app.inject(`/challenges/1/attempts/${a.id}`)).json().onChain).toEqual([{ kind: 'record_start', status: 'pending', txHash: null }]);
    // A creator's briefing reaches players only labelled as data.
    expect((await app.inject('/challenges')).json().untrusted).toMatch(/briefing.*never instructions/);
    expect(one.untrusted).toMatch(/briefing.*never instructions/);
    expect((await app.inject('/challenges/2')).statusCode).toBe(404);
    expect((await app.inject(`/challenges/2/attempts/${a.id}`)).statusCode).toBe(404);
    expect((await app.inject('/challenges/abc')).statusCode).toBe(404);
  });
});

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x! };
}
function signedHeaders(k: { privateKey: KeyObject; publicKey: string }, audience: string, method: string, path: string, body = '') {
  const timestamp = String(Date.now()), nonce = randomBytes(18).toString('base64url');
  const signature = sign(null, Buffer.from(signingString({ audience, method, path, timestamp, nonce, body })), k.privateKey).toString('base64url');
  return { 'x-vana-key': k.publicKey, 'x-vana-timestamp': timestamp, 'x-vana-nonce': nonce, 'x-vana-signature': signature,
    ...(body ? { 'content-type': 'application/json' } : {}) };
}

maybe('creator drafts', () => {
  const ORIGIN = 'https://wildsentia.test', WALLET = '0x' + 'c'.repeat(40);
  let app: FastifyInstance, store: ChallengeStore, who: { accountId: string; wallet: string | null; xAccountDays: number } | null, made: number;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor, accounts, live_agents cascade');
    await pool!.query(`insert into live_agents (id, kind, name, name_key, network_hash) values ('ag_00000000000000c1', 'human', 'Cre', 'cre', 'n')`);
    const { rows } = await pool!.query(`insert into accounts (id, x_user_id, x_handle, x_name, x_created_at, agent_id)
      values (gen_random_uuid(), '99', 'cre', 'Cre', now() - interval '400 days', 'ag_00000000000000c1') returning id`);
    who = { accountId: rows[0].id, wallet: WALLET, xAccountDays: 400 };
    made = 0;
    store = new ChallengeStore(pool!);
    app = Fastify();
    installChallenges(app, { store, catalog, drafts, adminToken: ADMIN, explorerUrl: null,
      creators: { origin: ORIGIN, account: async (req) => (req.headers.cookie === 'ws_session=good' ? who : null),
        draftsToday: async () => made } });
    await app.ready();
  });
  const body = { creatorWallet: '0x' + 'd'.repeat(40), terms: { template: 'hunt', speciesId: 'tiger' }, prizeUsdc: '5', days: 3 };
  const draft = (headers: Record<string, string> = {}, payload: object = body) => app.inject({ method: 'POST', url: '/challenges/drafts',
    headers: { cookie: 'ws_session=good', origin: ORIGIN, 'content-type': 'application/json', ...headers }, payload: JSON.stringify(payload) });

  it("drafts only from the signed-in creator's own wallet, within the limits", async () => {
    const ok = await draft();
    expect(ok.statusCode).toBe(200);
    // Whatever the body says, the creator is the account's linked wallet.
    expect(ok.json().typedData.message.from.toLowerCase()).toBe(WALLET);
    const saved = await store.draft(ok.json().draftId);
    expect(saved).toMatchObject({ creatorWallet: WALLET, accountId: who!.accountId });
    made = 3;
    expect((await draft()).json()).toEqual({ error: 'daily_limit' });
    made = 0;
    who = { ...who!, wallet: null };
    expect((await draft()).json()).toEqual({ error: 'wallet_required' });
    who = { ...who!, wallet: WALLET, xAccountDays: 29 };
    expect((await draft()).json()).toEqual({ error: 'x_account_too_new' });
    who = null;
    expect((await draft()).statusCode).toBe(401);
  });

  it('counts only challenges actually sent toward the three a day, and caps drafts at twenty a day even when sent all at once', async () => {
    const real = new AccountStore(pool!, new AgentStore(pool!));
    await app.close();
    app = Fastify();
    installChallenges(app, { store, catalog, drafts, adminToken: ADMIN, explorerUrl: null,
      creators: { origin: ORIGIN, account: async () => who, draftsToday: (accountId) => real.draftsToday(accountId) } });
    await app.ready();
    // Reviewing again and again without signing uses up nothing.
    const results = await Promise.all(Array.from({ length: 25 }, () => draft()));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(20);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(5);
    expect(await real.draftsToday(who!.accountId)).toBe(0);
    // The day's cap on drafts holds in the store itself, under its lock.
    const terms = { template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' } as const;
    const more = { creatorWallet: WALLET, terms, rulesHash: rulesHash(terms), prizeAtomic: '1000000', deadline: new Date(Date.now() + 86_400_000),
      salt: `0x${'1'.repeat(64)}` as `0x${string}`, authNonce: `0x${'9'.repeat(64)}` as `0x${string}`, accountId: who!.accountId };
    expect(await store.insertDraft(more, { sent: 3, total: 20 })).toBeNull();
    expect(await store.insertDraft(more, { sent: 3, total: 21 })).not.toBeNull();
    // Three sent (relayed, or on their way) use the day's three.
    await pool!.query(`update challenge_drafts set created_at = now() - interval '25 hours' where id not in
      (select id from challenge_drafts order by created_at desc limit 3)`);
    const ids = (await pool!.query('select id from challenge_drafts where created_at > now() - interval \'1 day\'')).rows.map((r) => r.id);
    await pool!.query('update challenge_drafts set relayed_at = now() where id = any($1)', [ids.slice(0, 2)]);
    await store.enqueueOp('relay_create', { draftId: ids[2] }, {});
    expect(await real.draftsToday(who!.accountId)).toBe(3);
    await app.close();
    app = Fastify(); // a fresh per-network limiter: this refusal is the daily limit's
    installChallenges(app, { store, catalog, drafts, adminToken: ADMIN, explorerUrl: null,
      creators: { origin: ORIGIN, account: async () => who, draftsToday: (accountId) => real.draftsToday(accountId) } });
    await app.ready();
    expect((await draft()).json()).toEqual({ error: 'daily_limit' });
  });

  it('refuses to relay a fourth challenge in a day from one creator', async () => {
    const made = [];
    for (let i = 0; i < 4; i++) made.push((await draft()).json().draftId as string);
    await pool!.query('update challenge_drafts set relayed_at = now() where id = any($1)', [made.slice(0, 3)]);
    const relay = await app.inject({ method: 'POST', url: `/challenges/drafts/${made[3]}/relay`, headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ signature: '0x' + '1'.repeat(130) }) });
    expect(relay.json()).toEqual({ error: 'daily_limit' });
  });

  it('reserves only three concurrent signed relays, and frees a failed reservation', async () => {
    const { draftTypedData, relayDraft } = await import('../src/challenges/drafts.js');
    const wallet = privateKeyToAccount(generatePrivateKey());
    who!.wallet = wallet.address;
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await draft()).json().draftId);
    const saved = await Promise.all(ids.map(id => store.draft(id)));
    const signatures = await Promise.all(saved.map(d => wallet.signTypedData(draftTypedData(drafts, d!))));
    // All four cheap preflight reads see zero; the transaction must enforce the actual cap.
    const count = store.sentDraftsToday.bind(store);
    let arrived = 0;
    let release!: () => void;
    const allRead = new Promise<void>(resolve => { release = resolve; });
    store.sentDraftsToday = async (...args) => {
      const n = await count(...args);
      if (++arrived === 4) release();
      await allRead;
      return n;
    };
    const results = await Promise.all(ids.map((id, i) => relayDraft(store, drafts, id, signatures[i], Date.now(), 3)));
    store.sentDraftsToday = count;
    expect(results.filter(result => result.ok)).toHaveLength(3);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, status: 429, error: 'daily_limit' }]);
    expect(await store.sentDraftsToday(who!.accountId, '00000000-0000-0000-0000-000000000000')).toBe(3);
    const first = (await store.activeOps())[0]!;
    await store.finishOp(first.id, 'failed', 'fixture_revert');
    const refused = results.findIndex(result => !result.ok);
    expect(await relayDraft(store, drafts, ids[refused]!, signatures[refused], Date.now(), 3)).toEqual({ ok: true });
    expect(await store.sentDraftsToday(who!.accountId, '00000000-0000-0000-0000-000000000000')).toBe(3);
  });

  it('refuses cross-site drafts, and still lets the operator draft with the token', async () => {
    expect((await draft({ origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await draft({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    const operator = await app.inject({ method: 'POST', url: '/challenges/drafts', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body) });
    expect(operator.statusCode).toBe(200);
    expect((await store.draft(operator.json().draftId))).toMatchObject({ creatorWallet: '0x' + 'd'.repeat(40), accountId: null });
    expect((await app.inject({ method: 'POST', url: '/challenges/drafts', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      payload: JSON.stringify(body) })).statusCode).toBe(401);
  });
});

maybe('agent challenge route', () => {
  it('accepts through the engine with the agent\'s proven wallet, and shows progress in observe', async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, live_possessions, live_agents cascade');
    const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
    const world = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { chital: 10 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    const agents = new AgentStore(pool!);
    const accept = vi.fn(async (): Promise<AcceptResult> => ({ ok: true, queued: false, attemptId: 'att-1', animalId: 'chital_1' }));
    const progressOf = vi.fn(() => ({ challengeId: 7, attemptId: 'att-1', goal: { template: 'hunt' as const, version: 1 as const, speciesId: 'tiger', count: 1, rules: [], briefing: '' },
      progress: { done: 0, of: 1, unit: 'kills' }, deadline: '2026-10-20T00:00:00.000Z' }));
    const waitingOf = vi.fn(() => ({ challengeId: 9, position: 1, until: '2026-10-10T00:30:00.000Z' }));
    const leave = vi.fn(() => true);
    const app = Fastify();
    installLiveAgents(app, { live: new LiveLayer(port), world: port, store: agents, ledger: null, limits: { slots: 5, perNetworkPerDay: 5 },
      networkSecret: 's', clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)),
      species: () => [...world.species.values()], challenges: { accept, progressOf, waitingOf, leave } });
    await app.ready();
    const k = keypair(), aud = 'vana:w1';
    const call = (method: 'GET' | 'POST', path: string, body?: object) => {
      const raw = body ? JSON.stringify(body) : '';
      return app.inject({ method, url: path, headers: signedHeaders(k, aud, method, path, raw), ...(raw ? { payload: raw } : {}) });
    };
    expect((await call('POST', '/agents/register', { name: 'Stripe' })).statusCode).toBe(200);
    const res = await call('POST', '/agents/me/challenges/7/accept');
    expect(res.json()).toEqual({ queued: false, attemptId: 'att-1', animalId: 'chital_1' });
    accept.mockResolvedValueOnce({ ok: true, queued: true, position: 2, until: '2026-10-10T00:30:00.000Z' });
    expect((await call('POST', '/agents/me/challenges/7/accept')).json()).toEqual({ queued: true, position: 2, until: '2026-10-10T00:30:00.000Z' });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ name: 'Stripe', wallet: null, walletProven: false }), 7);
    expect((await call('POST', '/agents/me/challenges/x/accept')).statusCode).toBe(404);
    const observed = (await call('GET', '/agents/me/observe')).json();
    expect(observed.challenge).toMatchObject({ challengeId: 7, progress: { unit: 'kills' } });
    expect(observed.waiting).toEqual({ challengeId: 9, position: 1, until: '2026-10-10T00:30:00.000Z' });
    expect(observed.guide).toBeNull(); // no animal yet
    expect((await call('POST', '/agents/me/challenges/leave')).json()).toEqual({ left: true });
    expect(leave).toHaveBeenCalledTimes(1);
    // The field guide, for any species and for the animal being played.
    expect((await app.inject('/agents/species')).json().species).toEqual(expect.arrayContaining([{ id: 'chital', displayName: 'Chital deer', kind: 'grazer' }]));
    expect((await app.inject('/agents/species/tiger')).json()).toMatchObject({ id: 'tiger', hunting: { chargesFromM: 25 } });
    expect((await app.inject('/agents/species/dragon')).statusCode).toBe(404);
    expect((await call('POST', '/agents/me/possess', { speciesId: 'chital' })).statusCode).toBe(200);
    expect((await call('GET', '/agents/me/observe')).json().guide).toMatchObject({ id: 'chital', social: { isHerd: true } });
    expect((await app.inject('/agents/guide.txt')).body).toMatch(/GET  \/agents\/species/);
    await app.close();
  });
});

maybe('challenges runtime', () => {
  it('refuses to start with a key that is not the contract\'s evaluator, and takes prize limits from the contract', async () => {
    await migrate(pool!);
    const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
    const world = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { chital: 4 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    const config: ChallengesConfig = { rpcUrl: 'http://127.0.0.1:1', chainId: 1, contract: drafts.contract, usdc: drafts.usdc,
      evaluatorKey: `0x${'a'.repeat(64)}`, fromBlock: 0, adminToken: ADMIN, usdcDomain: { name: 'USDC', version: '2' }, explorerUrl: null };
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor cascade');
    const chain = (appointed: string) => ({ contract: drafts.contract, evaluator: '0x' + 'e'.repeat(40), chainId: 1,
      appointedEvaluator: async () => appointed, prizeLimits: async () => ({ min: 2_000_000n, max: 50_000_000n }) }) as unknown as ChallengeChain;
    const deps = { pool: pool!, live: new LiveLayer(port), world: port, species: () => [...world.species.values()] };
    await expect(challengesRuntime(config, deps, chain('0x' + 'f'.repeat(40))).start()).rejects.toThrow("not the contract's evaluator");
    const ok = challengesRuntime(config, deps, chain('0x' + 'E'.repeat(40)));
    await ok.start();
    ok.stop();
    expect(ok.routes.drafts).toMatchObject({ minPrizeAtomic: 2_000_000n, maxPrizeAtomic: 50_000_000n });
    // Challenge posts are drafted beside it, for the owner's review.
    expect(typeof ok.social.sweep).toBe('function');

    // A database that holds another contract's challenges is refused; ours, by an old evaluator, become unplayable.
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor cascade');
    const store = new ChallengeStore(pool!);
    const terms = { template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' } as const;
    await store.insertDraft({ creatorWallet: '0x' + 'a'.repeat(40), terms, rulesHash: rulesHash(terms), prizeAtomic: '10000000',
      deadline: new Date('2026-10-20T00:00:00Z'), salt: `0x${'1'.repeat(64)}`, authNonce: `0x${'2'.repeat(64)}` });
    await store.recordCreated(drafts.contract, { id: 1, creator: '0x' + 'a'.repeat(40), prizeAtomic: '10000000', deadline: 1_792_454_400,
      rulesHash: rulesHash(terms), authNonce: `0x${'2'.repeat(64)}`, txHash: `0x${'3'.repeat(64)}`, blockNumber: 5 },
    { challenge: '0x' + '7'.repeat(40), ours: '0x' + '7'.repeat(40) });
    const again = challengesRuntime(config, deps, chain('0x' + 'E'.repeat(40)));
    await again.start();
    again.stop();
    expect((await store.challenge(1))!.status).toBe('unrecognised');
    await store.setCursor('0x' + '5'.repeat(40), 1);
    await expect(challengesRuntime(config, deps, chain('0x' + 'E'.repeat(40))).start()).rejects.toThrow('another contract');
  });

  it('keeps the forest running when the chain cannot be reached at startup, and starts challenges once it can', async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor cascade');
    const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
    const world = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { chital: 4 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    const config: ChallengesConfig = { rpcUrl: 'http://127.0.0.1:1', chainId: 1, contract: drafts.contract, usdc: drafts.usdc,
      evaluatorKey: `0x${'a'.repeat(64)}`, fromBlock: 0, adminToken: ADMIN, usdcDomain: { name: 'USDC', version: '2' }, explorerUrl: null };
    let reachable = false;
    const chain = { contract: drafts.contract, evaluator: '0x' + 'e'.repeat(40), chainId: 1,
      appointedEvaluator: async () => { if (!reachable) throw new Error('fetch failed'); return '0x' + 'e'.repeat(40); },
      prizeLimits: async () => ({ min: 2_000_000n, max: 50_000_000n }) } as unknown as ChallengeChain;
    const live = new LiveLayer(port);
    const priorTick = vi.fn(); live.onTick = priorTick;
    const runtime = challengesRuntime(config, { pool: pool!, live, world: port, species: () => [...world.species.values()] }, chain, { retryMs: 20 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runtime.start(); // does not throw: the outage is not a wrong key
      expect(runtime.routes.drafts.maxPrizeAtomic).toBe(0n); // nothing can be drafted yet
      expect(live.onHunt).toBeNull();
      reachable = true;
      await vi.waitFor(() => expect(runtime.routes.drafts.maxPrizeAtomic).toBe(50_000_000n), { timeout: 2000 });
      expect(live.onHunt).not.toBeNull();
      expect(live.onTick).not.toBe(priorTick);
      live.tick(0.1);
      expect(priorTick).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls.join(' ')).toMatch(/could not reach the chain/);
    } finally { runtime.stop(); errors.mockRestore(); }
    expect(live.onTick).toBe(priorTick);
  });

  it("refuses to start when the attempts contract's recorder is not the evaluator key", async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor cascade');
    const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
    const world = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { chital: 4 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    const config: ChallengesConfig = { rpcUrl: 'http://127.0.0.1:1', chainId: 1, contract: drafts.contract, usdc: drafts.usdc,
      evaluatorKey: `0x${'a'.repeat(64)}`, fromBlock: 0, adminToken: ADMIN, usdcDomain: { name: 'USDC', version: '2' }, explorerUrl: null,
      attemptsContract: `0x${'d'.repeat(40)}` };
    const chain = (recorder: string) => ({ contract: drafts.contract, evaluator: '0x' + 'e'.repeat(40), chainId: 1, attempts: config.attemptsContract,
      appointedEvaluator: async () => '0x' + 'e'.repeat(40), attemptsRecorder: async () => recorder,
      prizeLimits: async () => ({ min: 2_000_000n, max: 50_000_000n }) }) as unknown as ChallengeChain;
    const deps = { pool: pool!, live: new LiveLayer(port), world: port, species: () => [...world.species.values()] };
    await expect(challengesRuntime(config, deps, chain('0x' + 'f'.repeat(40))).start()).rejects.toThrow("not the attempts contract's recorder");
    const ok = challengesRuntime(config, deps, chain('0x' + 'E'.repeat(40)));
    await ok.start();
    ok.stop();
    // The runtime's species catalog knows herds and land.
    expect(ok.routes.catalog.social('chital')).toBe(true);
    expect(ok.routes.catalog.social('tiger')).toBe(false);
    const land = world.patches.find((p) => p.habitat === 'grassland')!;
    const c = patchCentre(ISLAND_GRID, land.id);
    expect(ok.routes.catalog.onLand(c.x, c.z)).toBe(true);
    expect(ok.routes.catalog.onLand(-1e5, -1e5)).toBe(false);
  });
});
