import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createWorld } from '@vana/sim';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ChallengeStore } from '../src/challenges/store.js';
import { installChallenges } from '../src/challenges/routes.js';
import { challengesConfig, challengesRuntime, type ChallengesConfig } from '../src/challenges/runtime.js';
import type { ChallengeChain } from '../src/challenges/chain.js';
import { rulesHash, type SpeciesCatalog } from '../src/challenges/terms.js';
import type { DraftConfig } from '../src/challenges/drafts.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { AgentStore } from '../src/live/liveStore.js';
import { installLiveAgents, walletProofMessage } from '../src/live/routes.js';
import { signingString } from '../src/live/signing.js';
// @ts-expect-error the agent client is plain JavaScript
import { walletMessage } from '../agent-client/client.mjs';
import { testDatabaseUrl } from './testDatabase.js';

describe('challenges configuration', () => {
  const full = { VANA_CHALLENGES: '1', VANA_LIVE_AGENTS: '1', VANA_CHALLENGES_RPC_URL: 'https://rpc.testnet.arc.io',
    VANA_CHALLENGES_CHAIN_ID: '5042002', VANA_CHALLENGES_CONTRACT: '0x' + '1'.repeat(40), VANA_CHALLENGES_USDC: '0x3600000000000000000000000000000000000000',
    VANA_CHALLENGES_EVALUATOR_KEY: '0x' + 'a'.repeat(64), VANA_CHALLENGES_FROM_BLOCK: '100', VANA_CHALLENGES_ADMIN_TOKEN: 'x'.repeat(40),
    VANA_CHALLENGES_USDC_DOMAIN_NAME: 'USDC', VANA_CHALLENGES_USDC_DOMAIN_VERSION: '2' };
  it('is off unless asked for, and complete when on', () => {
    expect(challengesConfig({})).toBeUndefined();
    expect(challengesConfig({ VANA_CHALLENGES: '0' })).toBeUndefined();
    expect(challengesConfig(full)).toMatchObject({ chainId: 5042002, fromBlock: 100, usdcDomain: { name: 'USDC', version: '2' }, explorerUrl: null });
  });
  it('refuses a partial or unsafe setup', () => {
    expect(() => challengesConfig({ ...full, VANA_LIVE_AGENTS: '0' })).toThrow('VANA_LIVE_AGENTS');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_CONTRACT: '' })).toThrow('VANA_CHALLENGES_CONTRACT');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_RPC_URL: 'http://rpc.example.com' })).toThrow('RPC_URL');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_EVALUATOR_KEY: '0x1234' })).toThrow('EVALUATOR_KEY');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_ADMIN_TOKEN: 'short' })).toThrow('ADMIN_TOKEN');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES: 'yes' })).toThrow('VANA_CHALLENGES');
  });
});

describe('agent client', () => {
  it('asks for the same wallet message the server checks', () => {
    expect(walletMessage('ag_0000000000000001', '0xABCDEF0000000000000000000000000000000001', 'vana:w1'))
      .toBe(walletProofMessage('ag_0000000000000001', '0xABCDEF0000000000000000000000000000000001', 'vana:w1'));
  });
});

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

const catalog: SpeciesCatalog = { ids: () => ['tiger', 'chital'], preyOf: (id) => (id === 'tiger' ? ['chital'] : []),
  displayName: (id) => (id === 'tiger' ? 'Tiger' : 'Chital') };
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
    expect(list[0]).toMatchObject({ status: 'open', description: 'Make a kill as a tiger', prizeUsdc: '10', createdTx: `0x${'3'.repeat(64)}` });
    const one = (await app.inject('/challenges/1')).json();
    expect(one.attempts[0]).toMatchObject({ id: a.id, agentName: 'Stripe', status: 'running' });
    expect((await app.inject(`/challenges/1/attempts/${a.id}`)).json()).toMatchObject({ log: [{ kind: 'start', data: { animalId: 'tiger_1' } }], resultHash: null });
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

maybe('agent challenge route', () => {
  it('accepts through the engine with the agent\'s proven wallet, and shows progress in observe', async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, live_possessions, live_agents cascade');
    const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
    const world = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { chital: 10 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    const agents = new AgentStore(pool!);
    const accept = vi.fn(async () => ({ ok: true as const, attemptId: 'att-1', animalId: 'chital_1' }));
    const progressOf = vi.fn(() => ({ challengeId: 7, attemptId: 'att-1', goal: { template: 'hunt' as const, version: 1 as const, speciesId: 'tiger', count: 1, rules: [], briefing: '' },
      progress: { done: 0, of: 1, unit: 'kills' }, deadline: '2026-10-20T00:00:00.000Z' }));
    const app = Fastify();
    installLiveAgents(app, { live: new LiveLayer(port), world: port, store: agents, ledger: null, limits: { slots: 5, perNetworkPerDay: 5 },
      networkSecret: 's', clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)), challenges: { accept, progressOf } });
    await app.ready();
    const k = keypair(), aud = 'vana:w1';
    const call = (method: 'GET' | 'POST', path: string, body?: object) => {
      const raw = body ? JSON.stringify(body) : '';
      return app.inject({ method, url: path, headers: signedHeaders(k, aud, method, path, raw), ...(raw ? { payload: raw } : {}) });
    };
    expect((await call('POST', '/agents/register', { name: 'Stripe' })).statusCode).toBe(200);
    const res = await call('POST', '/agents/me/challenges/7/accept');
    expect(res.json()).toEqual({ attemptId: 'att-1', animalId: 'chital_1' });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ name: 'Stripe', wallet: null, walletProven: false }), 7);
    expect((await call('POST', '/agents/me/challenges/x/accept')).statusCode).toBe(404);
    expect((await call('GET', '/agents/me/observe')).json().challenge).toMatchObject({ challengeId: 7, progress: { unit: 'kills' } });
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
});
