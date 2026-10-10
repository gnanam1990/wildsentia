import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { createWorld } from '@vana/sim';
import { keccak256, toBytes } from 'viem';
import { createPool } from '../src/db/pool.js';
import { installChallenges } from '../src/challenges/routes.js';
import { migrate } from '../src/db/migrate.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { AgentStore } from '../src/live/liveStore.js';
import { installLiveAgents } from '../src/live/routes.js';
import { ChallengeEngine } from '../src/challenges/engine.js';
import { ChainOps } from '../src/challenges/chainOps.js';
import { ChallengeStore } from '../src/challenges/store.js';
import { challengesConfig } from '../src/challenges/runtime.js';
import { rulesHash, type ChallengeTerms } from '../src/challenges/terms.js';
import type { ChainCall, ChallengeChain } from '../src/challenges/chain.js';
import { testDatabaseUrl } from './testDatabase.js';

type Hex = `0x${string}`;
const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });
const ORIGIN = 'https://wildsentia.test';
const WALLET = '0x' + 'b'.repeat(40);
const hex = (c: string) => `0x${c.repeat(64)}` as Hex;

describe('ERC-8004 settings', () => {
  const full = { VANA_CHALLENGES: '1', VANA_LIVE_AGENTS: '1', VANA_CHALLENGES_RPC_URL: 'https://rpc.testnet.arc.io',
    VANA_CHALLENGES_CHAIN_ID: '5042002', VANA_CHALLENGES_CONTRACT: '0x' + '1'.repeat(40), VANA_CHALLENGES_USDC: '0x3600000000000000000000000000000000000000',
    VANA_CHALLENGES_EVALUATOR_KEY: '0x' + 'a'.repeat(64), VANA_CHALLENGES_FROM_BLOCK: '100', VANA_CHALLENGES_ADMIN_TOKEN: 'x'.repeat(40),
    VANA_CHALLENGES_USDC_DOMAIN_NAME: 'USDC', VANA_CHALLENGES_USDC_DOMAIN_VERSION: '2' };
  it('needs the site address with the registries, since feedback points at the site', () => {
    const both = { ...full, VANA_CHALLENGES_IDENTITY_REGISTRY: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      VANA_CHALLENGES_REPUTATION_REGISTRY: '0x8004B663056A597Dffe9eCcC1965A193B7388713' };
    expect(() => challengesConfig(both)).toThrow('VANA_PUBLIC_ORIGIN');
    expect(challengesConfig({ ...both, VANA_PUBLIC_ORIGIN: 'https://wildsentia.lol' })!.reputationRegistry).toBeTruthy();
  });

  it('takes both registries or neither', () => {
    expect(challengesConfig(full)).toMatchObject({ identityRegistry: null, reputationRegistry: null });
    expect(challengesConfig({ ...full, VANA_CHALLENGES_IDENTITY_REGISTRY: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      VANA_CHALLENGES_REPUTATION_REGISTRY: '0x8004B663056A597Dffe9eCcC1965A193B7388713', VANA_PUBLIC_ORIGIN: 'https://wildsentia.lol' })).toMatchObject({
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713' });
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_IDENTITY_REGISTRY: '0x8004A818BFB912233c491871b3d84c89A494BD9e' })).toThrow('both');
  });
});

maybe('ERC-8004 identities and feedback', () => {
  let agents: AgentStore, store: ChallengeStore;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, live_possessions, live_agents cascade');
    agents = new AgentStore(pool!);
    store = new ChallengeStore(pool!);
    await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash, wallet, wallet_proven) values
      ('ag_0000000000000001', $1, 'Stripe', 'stripe', 'n', $2, true), ('ag_0000000000000002', $3, 'Kite', 'kite', 'n', null, false)`,
    ['1'.padEnd(43, 'A'), WALLET, '2'.padEnd(43, 'A')]);
  });

  it('links an identity only to one player', async () => {
    expect(await agents.setIdentity('ag_0000000000000001', '7')).toBe('ok');
    expect((await agents.byId('ag_0000000000000001'))!.erc8004AgentId).toBe('7');
    expect(await agents.setIdentity('ag_0000000000000002', '7')).toBe('identity_taken');
    expect(await agents.setIdentity('ag_0000000000000001', null)).toBe('ok');
    expect((await agents.byId('ag_0000000000000001'))!.erc8004AgentId).toBeNull();
  });

  it('links an identity the player\'s payout wallet owns, through the play routes', async () => {
    const world = createWorld({ seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)), terrainProfile: 'island_v1',
      initialAgents: { chital: 2 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w');
    const owners: Record<string, string | null> = { '7': WALLET, '8': '0x' + 'c'.repeat(40) };
    const app = Fastify();
    let who = 'ag_0000000000000001';
    installLiveAgents(app, { live: new LiveLayer(port), world: port, store: agents, ledger: null, limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's',
      clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)),
      humans: { origin: ORIGIN, account: async () => ({ agentId: who, xAccountDays: 400 }) },
      identity: { owner: async (id: bigint) => (owners[String(id)] ?? null) as Hex | null } });
    // The test's people resolver hands out agent rows; make them people for /play.
    await pool!.query("update live_agents set kind = 'human', public_key = null");
    await app.ready();
    const link = (erc8004AgentId: unknown) => app.inject({ method: 'POST', url: '/play/identity', headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: JSON.stringify({ erc8004AgentId }) });
    expect((await link('8')).json()).toEqual({ error: 'identity_not_owned_by_payout_wallet' });
    expect((await link('99')).json()).toEqual({ error: 'identity_not_found' });
    expect((await link('x')).json()).toEqual({ error: 'bad_identity' });
    expect((await link('007')).json()).toEqual({ erc8004AgentId: '7' }); // one spelling for one identity
    expect((await app.inject({ url: '/play/observe', headers: { origin: ORIGIN } })).json().you.erc8004AgentId).toBe('7');
    who = 'ag_0000000000000002';
    expect((await link('7')).json()).toEqual({ error: 'payout_wallet_required' });
    // The identity moves to Kite's wallet: Kite links it, and it leaves Stripe.
    await agents.setWallet('ag_0000000000000002', '0x' + 'c'.repeat(40));
    owners['7'] = '0x' + 'c'.repeat(40);
    expect((await link('7')).json()).toEqual({ erc8004AgentId: '7' });
    expect((await agents.byId('ag_0000000000000001'))!.erc8004AgentId).toBeNull();
    owners['7'] = WALLET;
    who = 'ag_0000000000000001';
    expect((await link(null)).json()).toEqual({ erc8004AgentId: null });
  });

  it('queues one feedback per met or failed attempt of a player with an identity, and sends it once a reputation registry is set', async () => {
    const terms: ChallengeTerms = { template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [], briefing: '' };
    await store.insertDraft({ creatorWallet: '0x' + 'a'.repeat(40), terms, rulesHash: rulesHash(terms), prizeAtomic: '1000000',
      deadline: new Date(Date.now() + 86_400_000), salt: hex('1'), authNonce: hex('2') });
    await store.recordCreated('0x' + 'c'.repeat(40), { id: 1, creator: '0x' + 'a'.repeat(40), prizeAtomic: '1000000', deadline: Math.floor(Date.now() / 1000) + 86_400,
      rulesHash: rulesHash(terms), authNonce: hex('2'), txHash: hex('3'), blockNumber: 1 }, { challenge: '0x' + 'e'.repeat(40), ours: '0x' + 'e'.repeat(40) });
    // An attempt that ended before the identity was linked leaves no feedback on it.
    const before = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'chital_0', payoutWallet: WALLET, startedWorld: 0, startState: {} });
    await store.endAttempt(before.id, 'failed', 'caught', 1);
    await pool!.query("update challenge_attempts set ended_at = now() - interval '1 hour' where id = $1", [before.id]);
    await agents.setIdentity('ag_0000000000000001', '7');
    const a = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'chital_1', payoutWallet: WALLET, startedWorld: 0, startState: {} });
    const b = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000002', animalId: 'chital_2', payoutWallet: WALLET, startedWorld: 0, startState: {} });
    await store.endAttempt(a.id, 'failed', 'caught', 5);
    await store.endAttempt(b.id, 'failed', 'caught', 5);
    const world = createWorld({ seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)), terrainProfile: 'island_v1',
      initialAgents: {}, minPopulation: {} });
    const port = worldPort(() => world, () => 'w');
    const engine = new ChallengeEngine(store, new LiveLayer(port), port, Date.now, { recordOnChain: false, feedback: { siteUrl: ORIGIN } });
    await engine.recordAttempts();
    await engine.recordAttempts();
    const ops = await store.opsOf({ attemptId: a.id });
    const record = (await store.attempt(a.id))!;
    expect(ops.map((o) => [o.kind, o.payload])).toEqual([['reputation', { agentId: '7', value: 0, tag2: 'failed', wallet: WALLET,
      endpoint: `${ORIGIN}/challenges.html?id=1`, feedbackURI: `${ORIGIN}/api/challenges/1/attempts/${a.id}/record`, feedbackHash: record.resultHash }]]);
    expect(await store.opsOf({ attemptId: before.id })).toEqual([]);
    // The feedbackURI serves exactly the text feedbackHash is the keccak256 of (ERC-8004).
    const site = Fastify();
    installChallenges(site, { store, catalog: { ids: () => [], preyOf: () => [], displayName: (x) => x, social: () => false, onLand: () => true },
      drafts: { chainId: 1, contract: ('0x' + 'c'.repeat(40)) as Hex, usdc: ('0x' + 'd'.repeat(40)) as Hex, usdcDomain: { name: 'USDC', version: '2' },
        minPrizeAtomic: 1n, maxPrizeAtomic: 2n }, adminToken: 'x'.repeat(40), explorerUrl: null });
    const served = await site.inject(`/challenges/1/attempts/${a.id}/record`);
    expect(served.headers['content-type']).toMatch(/^application\/json/);
    expect(keccak256(toBytes(served.body))).toBe(record.resultHash);
    expect((await site.inject(`/challenges/2/attempts/${a.id}/record`)).statusCode).toBe(404);
    // A player without an identity leaves none.
    expect(await store.opsOf({ attemptId: b.id })).toEqual([]);

    // ChainOps sends it as giveFeedback, and waits while no reputation registry is set.
    const sent: ChainCall[] = [];
    let owner: string | null = WALLET;
    const chain = { reputation: null as Hex | null, attempts: null, evaluator: '0x' + 'e'.repeat(40), identityOwner: async () => owner,
      prepare: async (call: ChainCall) => { sent.push(call); return { hash: hex('9'), raw: '0x01' as Hex, nonce: 0, maxFeePerGas: 1n }; },
      broadcast: async () => undefined, receipt: async () => 'success' as const, known: async () => true } as unknown as ChallengeChain;
    const chainOps = new ChainOps(store, chain);
    await chainOps.processOnce();
    expect(sent).toEqual([]);
    (chain as { reputation: Hex | null }).reputation = ('0x' + 'd'.repeat(40)) as Hex;
    await chainOps.processOnce();
    await chainOps.processOnce();
    expect(sent).toEqual([{ fn: 'giveFeedback', agentId: 7n, value: 0n, tag2: 'failed', endpoint: `${ORIGIN}/challenges.html?id=1`,
      feedbackURI: `${ORIGIN}/api/challenges/1/attempts/${a.id}/record`, feedbackHash: record.resultHash }]);
    expect((await store.opsOf({ attemptId: a.id }))[0]!.status).toBe('confirmed');
    // An identity that moved to another wallet before its feedback went out gets none.
    const c = await store.startAttempt({ challengeId: 1, agentId: 'ag_0000000000000001', animalId: 'chital_3', payoutWallet: WALLET, startedWorld: 0, startState: {} });
    await store.endAttempt(c.id, 'failed', 'caught', 9);
    await engine.recordAttempts();
    owner = '0x' + 'f'.repeat(40);
    await chainOps.processOnce();
    expect(sent).toHaveLength(1);
    expect((await store.opsOf({ attemptId: c.id }))[0]).toMatchObject({ status: 'failed', lastError: 'identity_moved' });
  });
});
