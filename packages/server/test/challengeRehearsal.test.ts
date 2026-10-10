import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { landWalkable, patchCentre } from '@vana/shared';
import { createWorld } from '@vana/sim';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { AgentStore } from '../src/live/liveStore.js';
import { installLiveAgents } from '../src/live/routes.js';
import { accountsConfig } from '../src/accounts/config.js';
import { AccountStore, CREATES_PER_DAY } from '../src/accounts/store.js';
import { installAccounts, sessionCookie } from '../src/accounts/routes.js';
import { cookie } from '../src/accounts/cookies.js';
import type { XAuth, XUser } from '../src/accounts/xAuth.js';
import { attemptKey, viemChallengeChain } from '../src/challenges/chain.js';
import { ChainOps } from '../src/challenges/chainOps.js';
import { ChallengeEngine, GRACE_SECONDS, REFUND_MARGIN_SECONDS } from '../src/challenges/engine.js';
import { ChallengeIndexer } from '../src/challenges/indexer.js';
import { installChallenges } from '../src/challenges/routes.js';
import { ChallengeSocialStore } from '../src/challenges/social.js';
import { installChallengeSocial } from '../src/challenges/socialRoutes.js';
import { ChallengeStore } from '../src/challenges/store.js';
import type { SpeciesCatalog } from '../src/challenges/terms.js';
import { installSocialOutbox } from '../src/socialOutbox.js';
import type { XPublisher } from '../src/xPublisher.js';
import { ANVIL_KEYS, CHAIN_ID, anvilAvailable, startLocalChain, usdcBalance, type LocalChain } from './anvil.js';
import { testDatabaseUrl } from './testDatabase.js';

/**
 * Plan 4's rehearsal on a local chain: every step a person takes on the site, through the real
 * routes, with both contracts deployed — the testnet journeys of deploy/arc-testnet.md, minus Arc.
 * LOCAL TEST STAND-IN USDC and anvil's public development keys only.
 */
const url = testDatabaseUrl();
const maybe = url && anvilAvailable() ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const ORIGIN = 'https://wildsentia.test';
const SOCIAL_TOKEN = 'rehearsal-social-token-'.repeat(2);

maybe('rehearsal: the testnet journeys on a local chain, through the site\'s own routes', () => {
  let local: LocalChain, app: FastifyInstance, now: number;
  let engine: ChallengeEngine, ops: ChainOps, indexer: ChallengeIndexer, store: ChallengeStore, social: ChallengeSocialStore, live: LiveLayer;
  let world: ReturnType<typeof createWorld>;
  let signingIn: XUser;
  const posted: string[] = [];

  beforeAll(async () => {
    local = await startLocalChain();
    await migrate(pool!);
    await pool!.query(`truncate challenge_social_drafts, challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts,
      challenge_index_cursor, account_sessions, accounts, live_possessions, live_agents cascade`);
    now = Date.now();
    world = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1', initialAgents: { tiger: 2, chital: 12 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w');
    const catalog: SpeciesCatalog = { ids: () => [...world.species.keys()], preyOf: (id) => port.species(id)?.preferredPrey ?? [],
      displayName: (id) => port.species(id)?.displayName ?? id, social: () => true, onLand: (x, z) => port.patchAt(x, z)?.land === true };
    const chain = viemChallengeChain({ rpcUrl: local.url, chainId: CHAIN_ID, contract: local.contract, evaluatorKey: ANVIL_KEYS.evaluator,
      attemptsContract: local.attempts, identityRegistry: local.identity, reputationRegistry: local.reputation });
    store = new ChallengeStore(pool!);
    live = new LiveLayer(port, null, () => now, () => 0);
    engine = new ChallengeEngine(store, live, port, () => now, { recordOnChain: true, feedback: { siteUrl: ORIGIN } });
    live.onHunt = (h) => engine.onHunt(h); live.onCommand = (c) => engine.onCommand(c); live.onEnded = (l) => engine.onEnded(l);
    await engine.restore();
    ops = new ChainOps(store, chain, () => now);
    indexer = new ChallengeIndexer(store, chain, 0);
    social = new ChallengeSocialStore(pool!, catalog, ORIGIN, chain.evaluator);
    const agents = new AgentStore(pool!);
    const config = accountsConfig({ VANA_X_CLIENT_ID: 'rehearsal', VANA_X_CLIENT_SECRET: 'rehearsal-secret', VANA_X_REDIRECT_URI: `${ORIGIN}/api/accounts/x/callback` })!;
    const accounts = new AccountStore(pool!, agents, () => now);
    const x: XAuth = { authorizeUrl: ({ state }) => `https://x.com/i/oauth2/authorize?state=${state}`, signIn: async () => signingIn };
    const signedIn = (req: Parameters<typeof cookie>[0]) => accounts.fromSession(cookie(req, sessionCookie(config)));
    const publisher: XPublisher = { accountId: '42', verifyAccount: async () => undefined,
      create: async (text) => { posted.push(text); return { id: String(9000 + posted.length), text }; }, lookup: async () => null };
    app = Fastify({ logger: false });
    installAccounts(app, { config, store: accounts, x, clock: () => now, wallet: { chainId: CHAIN_ID } });
    installLiveAgents(app, { live, world: port, store: agents, ledger: null, limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's',
      clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)), species: () => [...world.species.values()],
      identity: { owner: (id) => chain.identityOwner(id) },
      challenges: { accept: (p, id) => engine.accept(p, id), progressOf: (a) => engine.progressOf(a), waitingOf: (a) => engine.waitingOf(a), leave: (a) => engine.leave(a) },
      humans: { origin: ORIGIN, account: async (req) => { const a = await signedIn(req); return a ? { agentId: a.agentId, xAccountDays: accounts.xAccountDays(a) } : null; } } });
    installChallenges(app, { store, catalog, adminToken: 'operator-token-'.repeat(3), explorerUrl: null, clock: () => now,
      drafts: { chainId: CHAIN_ID, contract: local.contract, usdc: local.usdc, usdcDomain: { name: 'USDC', version: '2' }, minPrizeAtomic: 1_000_000n, maxPrizeAtomic: 100_000_000n },
      creators: { origin: ORIGIN, draftsToday: (id) => accounts.draftsToday(id), account: async (req) => {
        const a = await signedIn(req); if (!a) return null;
        const agent = await agents.byId(a.agentId);
        return { accountId: a.id, wallet: agent?.walletProven ? agent.wallet : null, xAccountDays: accounts.xAccountDays(a) };
      } } });
    installSocialOutbox(app, { pool: pool!, config: { adminToken: SOCIAL_TOKEN, xPublisher: publisher }, boundary: () => null });
    installChallengeSocial(app, { social, publisher });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); local?.stop(); await pool?.end(); });

  // ---- what a browser does --------------------------------------------------------------
  const cookieName = '__Host-ws_session';
  const signIn = async (user: XUser) => {
    signingIn = user;
    const start = await app.inject('/accounts/x/start');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const sealed = String(([] as string[]).concat(start.headers['set-cookie'] as string).find((c) => c.startsWith('__Host-ws_oauth='))).split(';')[0]!;
    const back = await app.inject({ url: `/accounts/x/callback?code=c&state=${state}`, headers: { cookie: sealed } });
    return String(([] as string[]).concat(back.headers['set-cookie'] as string).find((c) => c.startsWith(`${cookieName}=`))).split(';')[0]!.split('=')[1]!;
  };
  const as = (session: string) => (method: 'GET' | 'POST', path: string, body?: object) => app.inject({ method, url: path,
    headers: { cookie: `${cookieName}=${session}`, origin: ORIGIN, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
  const linkWallet = async (session: string, key: Hex) => {
    const account = privateKeyToAccount(key), call = as(session);
    const c = (await call('POST', '/accounts/wallet/challenge', { address: account.address })).json();
    const signature = await account.signMessage({ message: c.message });
    return (await call('POST', '/accounts/wallet/verify', { address: account.address, nonce: c.nonce, signature })).json();
  };
  const create = async (session: string, key: Hex, body: object) => {
    const call = as(session);
    const draft = (await call('POST', '/challenges/drafts', body)).json();
    // The page's own checks pass, then the wallet signs the typed data the server gave.
    const t = draft.typedData;
    const signature = await privateKeyToAccount(key).signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType,
      message: { ...t.message, value: BigInt(t.message.value), validAfter: BigInt(t.message.validAfter), validBefore: BigInt(t.message.validBefore) } });
    expect((await call('POST', `/challenges/drafts/${draft.draftId}/relay`, { signature })).statusCode).toBe(202);
    return draft;
  };
  /** The server's timers, run until a condition holds. */
  const settle = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 150 && !(await done()); i++) {
      await ops.processOnce(); await engine.recordAttempts(); await engine.tick();
      await local.mine(1); await indexer.pollOnce(); await social.sweep();
    }
    expect(await done()).toBe(true);
  };
  const admin = (method: 'GET' | 'POST', path: string, body?: object) => app.inject({ method, url: path,
    headers: { authorization: `Bearer ${SOCIAL_TOKEN}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
  const old = new Date('2020-01-01T00:00:00Z');

  it('journeys 1, 2 and 4: a person creates a challenge, another person plays it through /play and is paid, with every record on chain', async () => {
    // Journey 1: the creator signs in with X, links a wallet and creates a 10 USDC hunt challenge.
    const creator = await signIn({ id: '101', username: 'creator_c', name: 'Creator', createdAt: old });
    expect(await linkWallet(creator, ANVIL_KEYS.creator)).toEqual({ wallet: local.addresses.creator.toLowerCase() });
    const before = await usdcBalance(local, local.addresses.creator);
    const draft = await create(creator, ANVIL_KEYS.creator, { terms: { template: 'hunt', speciesId: 'tiger', briefing: 'Stalk from the grass.' }, prizeUsdc: '10', days: 3 });
    expect(draft.description).toBe('Make a kill as a tiger');
    await settle(async () => (await store.challenge(1))?.status === 'open');
    expect(await usdcBalance(local, local.addresses.creator)).toBe(before - 10_000_000n);
    expect((await app.inject('/challenges/1')).json().challenge).toMatchObject({ status: 'open', goal: { briefing: 'Stalk from the grass.' } });
    // The creator cannot play it, whatever wallet they link later.
    expect((await as(creator)('POST', '/play/challenges/1/accept')).json()).toEqual({ error: 'creator_cannot_play' });

    // Journey 2: a player signs in, links a wallet, accepts, and hunts from the play page.
    const player = await signIn({ id: '202', username: 'player_p', name: 'Player', createdAt: old });
    await linkWallet(player, ANVIL_KEYS.player);
    const play = as(player);
    // The player registers an ERC-8004 identity with their wallet, and links it.
    const playerWallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS.player), transport: http(local.url), chain: null });
    await createPublicClient({ cacheTime: 0, transport: http(local.url) }).waitForTransactionReceipt({ hash: await playerWallet.writeContract({
      address: local.identity, chain: null, abi: parseAbi(['function register(string)']), functionName: 'register', args: ['https://example.test/player.json'] }) });
    expect((await play('POST', '/play/identity', { erc8004AgentId: '1' })).json()).toEqual({ erc8004AgentId: '1' });
    const accepted = (await play('POST', '/play/challenges/1/accept')).json();
    expect(accepted).toMatchObject({ queued: false });
    const observed = (await play('GET', '/play/observe')).json();
    expect(observed.challenge).toMatchObject({ challengeId: 1, briefing: 'Stalk from the grass.', progress: { unit: 'kills' } });
    expect(observed.guide).toMatchObject({ id: 'tiger' });
    const open = world.patches.find((p) => landWalkable(p) && p.neighbours.every((n) => landWalkable(world.patches[n])))!;
    const c = patchCentre(open.id), me = live.avatars.get(observed.you.agentId)!;
    const tiger = world.animal(accepted.animalId)!, prey = world.agents.find((a) => a.alive && a.speciesId === 'chital' && a.lifeStage === 'adult')!;
    tiger.patchId = open.id; tiger.position = { x: c.x, z: c.z, heading: 0 }; me.x = c.x; me.z = c.z;
    prey.patchId = open.id; prey.position = { x: c.x + 30, z: c.z, heading: 0 };
    expect((await play('POST', '/play/hunt', { animalId: prey.id })).json()).toEqual({ ok: true });
    for (let i = 0; i < 600; i++) { now += 100; live.tick(0.1); }

    // The kill wins; the contract pays the player's linked wallet and stores the record's hash.
    await settle(async () => (await store.challenge(1))?.status === 'paid');
    expect(await usdcBalance(local, local.addresses.player)).toBe(10_000_000n);
    const attempt = (await store.attempt(accepted.attemptId))!;
    const reader = createPublicClient({ cacheTime: 0, transport: http(local.url) });
    const onChain = await reader.readContract({ address: local.contract, abi: parseAbi([
      'struct Challenge { address creator; uint96 prize; address winner; uint64 deadline; uint8 status; bytes32 rulesHash; bytes32 resultHash; address evaluator; }',
      'function challenge(uint256) view returns (Challenge)']), functionName: 'challenge', args: [1n] });
    expect(onChain.resultHash).toBe(attempt.resultHash);

    // Journey 4: the attempt's start and end are both written to WildsentiaAttempts.
    const stage = () => reader.readContract({ address: local.attempts, abi: parseAbi(['function stage(bytes32) view returns (uint8)']),
      functionName: 'stage', args: [attemptKey(accepted.attemptId)] });
    await settle(async () => (await stage()) === 2
      && (await store.opsOf({ attemptId: accepted.attemptId })).every((o) => o.status === 'confirmed'));
    // ERC-8004: the win leaves one feedback on the player's identity, from the evaluator, pointing at the record.
    await settle(async () => (await store.opsOf({ attemptId: accepted.attemptId })).some((o) => o.kind === 'reputation' && o.status === 'confirmed'));
    const feedback = await reader.getLogs({ address: local.reputation, fromBlock: 0n, event: parseAbi(['event NewFeedback(uint256 indexed agentId, address indexed clientAddress, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)'])[0] });
    expect(feedback.map((l) => [l.args.agentId, l.args.value, l.args.tag2, l.args.feedbackURI, l.args.feedbackHash])).toEqual([[1n, 100n, 'met',
      `${ORIGIN}/api/challenges/1/attempts/${accepted.attemptId}`, attempt.resultHash]]);
    const page = (await app.inject(`/challenges/1/attempts/${accepted.attemptId}`)).json();
    expect(page.onChain.map((o: { kind: string; status: string }) => [o.kind, o.status]).sort()).toEqual([['record_end', 'confirmed'],
      ['record_start', 'confirmed'], ['reputation', 'confirmed']]);

    // The owner reviews and posts the "won" post once; the briefing is in none of them.
    await settle(async () => (await social.list()).some((d) => d.kind === 'won'));
    const won = (await admin('GET', '/admin/social/challenges')).json().drafts.find((d: { kind: string }) => d.kind === 'won');
    expect(won.body).toBe(`Wildsentia challenge 1 was won by player_p: make a kill as a tiger. 10 USDC paid on Arc. ${ORIGIN}/challenges.html?id=1`);
    await admin('POST', `/admin/social/challenges/${won.id}/review`, { action: 'approve' });
    expect((await admin('POST', `/admin/social/challenges/${won.id}/publish`)).json()).toMatchObject({ status: 'published' });
    expect(posted).toEqual([won.body]);
    expect(JSON.stringify(await social.list())).not.toMatch(/Stalk from the grass/);
  });

  it('journey 3: a challenge nobody meets goes back to its creator an hour after its deadline', async () => {
    const creator = await signIn({ id: '101', username: 'creator_c', name: 'Creator', createdAt: old });
    const before = await usdcBalance(local, local.addresses.creator);
    await create(creator, ANVIL_KEYS.creator, { terms: { template: 'survive', speciesId: 'chital', days: 7 }, prizeUsdc: '5', days: 1 });
    await settle(async () => (await store.challenge(2))?.status === 'open');
    expect(await usdcBalance(local, local.addresses.creator)).toBe(before - 5_000_000n);
    // Two sent today: one of the creator's three left.
    expect((await as(creator)('GET', '/accounts/me')).json().account.createsLeftToday).toBe(CREATES_PER_DAY - 2);
    // A day, the grace hour and the margin pass, on the chain and on the server.
    const wait = 86_400 + GRACE_SECONDS + REFUND_MARGIN_SECONDS + 120;
    await local.mine(wait);
    now += wait * 1000;
    await engine.sweep();
    await settle(async () => (await store.challenge(2))?.status === 'refunded');
    expect(await usdcBalance(local, local.addresses.creator)).toBe(before);
    const refunded = (await social.list()).find((d) => d.challengeId === 2 && d.kind === 'refunded');
    expect(refunded?.body).toMatch(/^Nobody met Wildsentia challenge 2 in time/);
  });
});
