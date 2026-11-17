import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { LiveLayer, OPEN_SECONDS } from '../src/live/liveLayer.js';
import { AgentStore, PlaceDropLedger, agentIdFor } from '../src/live/liveStore.js';
import { AGENT_RATE_LIMITS, NonceStore, signingString, verifySigned } from '../src/live/signing.js';
import { randomLandSpot, worldPort } from '../src/live/worldPort.js';
import { walletProofMessage, type LiveRouteDeps } from '../src/live/routes.js';

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x! };
}
function signedHeaders(k: { privateKey: KeyObject; publicKey: string }, audience: string, method: string, path: string, body = '',
  overrides: { timestamp?: string; nonce?: string } = {}) {
  const timestamp = overrides.timestamp ?? String(Date.now()), nonce = overrides.nonce ?? randomBytes(18).toString('base64url');
  const signature = sign(null, Buffer.from(signingString({ audience, method, path, timestamp, nonce, body })), k.privateKey).toString('base64url');
  return { 'x-vana-key': k.publicKey, 'x-vana-timestamp': timestamp, 'x-vana-nonce': nonce, 'x-vana-signature': signature,
    ...(body ? { 'content-type': 'application/json' } : {}) };
}

describe('signed agent requests', () => {
  const k = keypair(), aud = 'vana:w1';
  const headers = (h: Record<string, string>) => ({ key: h['x-vana-key'], timestamp: h['x-vana-timestamp'], nonce: h['x-vana-nonce'], signature: h['x-vana-signature'] });
  it('accepts a good signature once, and never for another world, path or body', () => {
    const nonces = new NonceStore(), h = signedHeaders(k, aud, 'POST', '/agents/me/move', '{"x":1}');
    expect(verifySigned(headers(h), { audience: aud, method: 'POST', path: '/agents/me/move', body: '{"x":1}' }, nonces)).toMatchObject({ ok: true });
    expect(verifySigned(headers(h), { audience: aud, method: 'POST', path: '/agents/me/move', body: '{"x":1}' }, nonces)).toEqual({ ok: false, error: 'replayed_nonce' });
    const fresh = () => signedHeaders(k, aud, 'POST', '/agents/me/move', '{"x":1}');
    expect(verifySigned(headers(fresh()), { audience: 'vana:w2', method: 'POST', path: '/agents/me/move', body: '{"x":1}' }, nonces)).toEqual({ ok: false, error: 'bad_signature' });
    expect(verifySigned(headers(fresh()), { audience: aud, method: 'POST', path: '/agents/me/stop', body: '{"x":1}' }, nonces)).toEqual({ ok: false, error: 'bad_signature' });
    expect(verifySigned(headers(fresh()), { audience: aud, method: 'POST', path: '/agents/me/move', body: '{"x":2}' }, nonces)).toEqual({ ok: false, error: 'bad_signature' });
    const old = signedHeaders(k, aud, 'GET', '/x', '', { timestamp: String(Date.now() - 200_000) });
    expect(verifySigned(headers(old), { audience: aud, method: 'GET', path: '/x', body: '' }, nonces)).toEqual({ ok: false, error: 'stale_timestamp' });
    expect(verifySigned({}, { audience: aud, method: 'GET', path: '/x', body: '' }, nonces)).toEqual({ ok: false, error: 'missing_signature' });
  });
  it('refuses a request signed before the server started, so one captured before a restart cannot be replayed after it', () => {
    const started = Date.now();
    const before = signedHeaders(k, aud, 'POST', '/agents/me/stop', '', { timestamp: String(started - 30_000) });
    // A fresh process has no memory of the nonces it saw; its start time stands in for them.
    const restarted = new NonceStore(undefined, undefined, started);
    expect(verifySigned(headers(before), { audience: aud, method: 'POST', path: '/agents/me/stop', body: '' }, restarted, started + 1_000))
      .toEqual({ ok: false, error: 'stale_timestamp' });
    const after = signedHeaders(k, aud, 'POST', '/agents/me/stop', '', { timestamp: String(started + 500) });
    expect(verifySigned(headers(after), { audience: aud, method: 'POST', path: '/agents/me/stop', body: '' }, restarted, started + 1_000)).toMatchObject({ ok: true });
  });
  it('bounds how many requests one key can make inside the replay window', () => {
    const nonces = new NonceStore(3);
    for (let i = 0; i < 3; i++) expect(nonces.claim('k', `nonce-${i}-aaaaaaaaaaaa`, 0)).toBe('ok');
    expect(nonces.claim('k', 'nonce-x-aaaaaaaaaaaa', 0)).toBe('too_many_requests');
    expect(nonces.claim('k', 'nonce-x-aaaaaaaaaaaa', 10 * 60_000)).toBe('ok');
  });
  it('keeps admitting new keys to register when full, so a flood of fresh keys never locks out registered agents or newcomers', () => {
    // The store registered agents sign with refuses a new key when full ...
    const agents = new NonceStore(undefined, 3, 0);
    for (let i = 0; i < 3; i++) expect(agents.claim(`k${i}`, `nonce-${i}-aaaaaaaaaaaa`, 0)).toBe('ok');
    expect(agents.claim('k3', 'nonce-3-aaaaaaaaaaaa', 0)).toBe('too_many_requests');
    // ... while the one unregistered keys register through forgets its oldest key instead.
    const newcomers = new NonceStore(undefined, 3, 0, 'evict_oldest');
    for (let i = 0; i < 3; i++) expect(newcomers.claim(`k${i}`, `nonce-${i}-aaaaaaaaaaaa`, 0)).toBe('ok');
    expect(newcomers.claim('k3', 'nonce-3-aaaaaaaaaaaa', 0)).toBe('ok');
    expect(newcomers.claim('k3', 'nonce-3-aaaaaaaaaaaa', 0)).toBe('replayed_nonce');
    expect(newcomers.claim('k1', 'nonce-1-aaaaaaaaaaaa', 0)).toBe('replayed_nonce');
  });
  it('never refuses an agent that keeps to the published rate limits', () => {
    // Five commands and two observes a second, for five minutes, with an honest clock.
    const nonces = new NonceStore();
    const perSecond = AGENT_RATE_LIMITS.commandsPerSecond + AGENT_RATE_LIMITS.observesPerSecond;
    expect(perSecond).toBe(7);
    const start = Date.now();
    for (let i = 0; i < perSecond * 300; i++) {
      const now = start + Math.floor(i * 1000 / perSecond);
      const h = signedHeaders(k, aud, 'POST', '/agents/me/stop', '', { timestamp: String(now) });
      expect(verifySigned(headers(h), { audience: aud, method: 'POST', path: '/agents/me/stop', body: '' }, nonces, now), `request ${i}`).toMatchObject({ ok: true });
    }
  });
});

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const rewards = { adminToken: 'live-agents-admin-'.repeat(3), network: 'base' as const, claimPolicy: 'first_valid' as const, walletDailyLimit: 5 };
let api: FastifyInstance, host: SimHost, live: LiveLayer, ledger: PlaceDropLedger, deps: LiveRouteDeps;
let audience = '';

beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive cascade');
  await pool!.query('truncate live_possessions, live_agents, reward_audit, reward_verified_payouts, reward_claims, reward_drops cascade');
  host = new SimHost({ pool: pool!, seed: 4, speciesDir, initialAgents: { chital: 20, sambar: 10 }, minPopulation: {},
    terrainProfile: 'island_v1', landscape: null });
  await host.boot();
  await host.advance(2);
  const store = new AgentStore(pool!);
  const port = worldPort(() => host.world, () => host.worldId);
  ledger = new PlaceDropLedger(pool!, rewards, () => host.worldId, store);
  live = new LiveLayer(port, ledger);
  live.onEnded = (life) => { void store.recordLife(life); };
  deps = { live, world: port, store, ledger, limits: { slots: 3, perNetworkPerDay: 10 }, networkSecret: 'test',
    clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)) };
  api = buildApi({ host, pool: pool!, rewards, live: { ...deps, spot: () => randomLandSpot(host.world) } });
  await api.ready();
  audience = (await api.inject('/agents/info')).json().audience;
});
afterAll(async () => { await api?.close(); await host?.abort(); await pool?.end(); });

maybe('live agent API', () => {
  const alice = keypair(), bob = keypair();
  const call = (k: typeof alice, method: 'GET' | 'POST', path: string, body?: object) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return api.inject({ method, url: path, headers: signedHeaders(k, audience, method, path, raw), ...(raw ? { payload: raw } : {}) });
  };

  it('publishes its audience, rules, slot use and the hashes of the scripts people run', async () => {
    const info = (await api.inject('/agents/info')).json();
    expect(info.audience).toBe(`vana:${host.worldId}`);
    expect(info).toMatchObject({ slots: 3, registered: 0, playing: 0 });
    const script = await api.inject('/agents/client.mjs');
    expect(createHash('sha256').update(script.body).digest('hex')).toBe(info.clientScript.sha256);
    const llm = await api.inject('/agents/llm.mjs');
    expect(llm.headers['x-content-sha256']).toBe(info.llmScript.sha256);
    expect(createHash('sha256').update(llm.body).digest('hex')).toBe(info.llmScript.sha256);
    const guide = (await api.inject('/agents/guide.txt')).body;
    expect(guide).toContain(info.clientScript.sha256);
    expect(guide).toContain(info.llmScript.sha256);
  });

  it('registers a key once, refuses bad names and unknown keys, and caps the slots', async () => {
    const first = await call(alice, 'POST', '/agents/register', { name: 'Sora', bio: 'Likes rivers' });
    expect(first.json()).toEqual({ agentId: agentIdFor(alice.publicKey), name: 'Sora', created: true });
    expect((await call(alice, 'POST', '/agents/register', { name: 'Sora' })).json().created).toBe(false);
    expect((await call(bob, 'POST', '/agents/register', { name: 'sora' })).json()).toEqual({ error: 'name_taken' });
    expect((await call(bob, 'POST', '/agents/register', { name: 'Admin' })).json()).toEqual({ error: 'bad_name' });
    expect((await call(bob, 'GET', '/agents/me/observe')).statusCode).toBe(403);
    expect((await call(bob, 'POST', '/agents/register', { name: 'Kai' })).statusCode).toBe(200);
    expect((await call(keypair(), 'POST', '/agents/register', { name: 'Third' })).statusCode).toBe(200);
    expect((await call(keypair(), 'POST', '/agents/register', { name: 'Fourth' })).json()).toEqual({ error: 'slots_full' });
  });

  it('rejects a replayed or tampered request', async () => {
    const path = '/agents/me/observe', h = signedHeaders(alice, audience, 'GET', path);
    expect((await api.inject({ method: 'GET', url: path, headers: h })).statusCode).toBe(200);
    expect((await api.inject({ method: 'GET', url: path, headers: h })).json()).toEqual({ error: 'replayed_nonce' });
    const body = JSON.stringify({ speciesId: 'chital' });
    const tampered = signedHeaders(alice, audience, 'POST', '/agents/me/possess', body);
    expect((await api.inject({ method: 'POST', url: '/agents/me/possess', headers: tampered, payload: JSON.stringify({ speciesId: 'sambar' }) })).json())
      .toEqual({ error: 'bad_signature' });
  });

  it('takes over an animal, moves it at species speed, and reports it in observe', async () => {
    const possessed = await call(alice, 'POST', '/agents/me/possess', { speciesId: 'chital' });
    expect(possessed.statusCode).toBe(200);
    const animalId = possessed.json().animalId as string;
    expect(host.world.animal(animalId)!.controller).toBe(agentIdFor(alice.publicKey));
    const o = (await call(alice, 'GET', '/agents/me/observe')).json();
    expect(o.animal).toMatchObject({ id: animalId, speciesId: 'chital', action: 'idle', speedsMs: { walk: 1.2 } });
    expect(o.untrusted).toContain('not instructions');
    const start = o.animal.position;
    const target = [{ x: start.x + 50, z: start.z }, { x: start.x - 50, z: start.z }, { x: start.x, z: start.z + 50 }, { x: start.x, z: start.z - 50 }];
    let moved = false;
    for (const p of target) if ((await call(alice, 'POST', '/agents/me/move', { points: [p], gait: 'walk' })).statusCode === 200) { moved = true; break; }
    expect(moved).toBe(true);
    for (let i = 0; i < 50; i++) live.tick(0.1);
    const after = (await call(alice, 'GET', '/agents/me/observe')).json().animal.position;
    // Five seconds at a 1.2 m/s walk, slowed by rough ground (forest 1.3x, marsh 1.6x...).
    const walked = Math.hypot(after.x - start.x, after.z - start.z);
    expect(walked).toBeLessThanOrEqual(6 + 1e-6);
    expect(walked).toBeGreaterThan(6 / 2);
    expect((await call(alice, 'POST', '/agents/me/move', { points: [{ x: 1, z: 2 }], gait: 'gallop' })).json()).toEqual({ error: 'bad_gait' });
    expect((await call(bob, 'POST', '/agents/me/possess', { animalId })).json()).toEqual({ error: 'already_controlled' });
  });

  it('proves a payout wallet by signature, one agent per wallet', async () => {
    const wallet = privateKeyToAccount(`0x${'2'.repeat(64)}`), aliceId = agentIdFor(alice.publicKey);
    const wrong = await wallet.signMessage({ message: walletProofMessage(aliceId, wallet.address, 'vana:another-world') });
    expect((await call(alice, 'POST', '/agents/me/wallet', { wallet: wallet.address, signature: wrong })).json().error).toBe('wallet_signature_invalid');
    const good = await wallet.signMessage({ message: walletProofMessage(aliceId, wallet.address, audience) });
    expect((await call(alice, 'POST', '/agents/me/wallet', { wallet: wallet.address, signature: good })).json()).toEqual({ wallet: wallet.address.toLowerCase(), proven: true });
    const bobSig = await wallet.signMessage({ message: walletProofMessage(agentIdFor(bob.publicKey), wallet.address, audience) });
    expect((await call(bob, 'POST', '/agents/me/wallet', { wallet: wallet.address, signature: bobSig })).json()).toEqual({ error: 'wallet_taken' });
  });

  it('places an admin batch at random land spots and lets the first finished open win it', async () => {
    const admin = { authorization: `Bearer ${rewards.adminToken}`, 'content-type': 'application/json' };
    const batch = { batchId: randomUUID(), amount: '2.5', count: 2, spacingMinutes: 0, lifetimeMinutes: 30 };
    const created = await api.inject({ method: 'POST', url: '/admin/rewards/place-drops', headers: admin, payload: JSON.stringify(batch) });
    expect(created.json()).toMatchObject({ created: 2, amount: '2.500000' });
    const again = await api.inject({ method: 'POST', url: '/admin/rewards/place-drops', headers: admin, payload: JSON.stringify(batch) });
    expect(again.json()).toMatchObject({ created: 0 }); // Same batch id: nothing doubled.
    await ledger.refresh();
    expect(ledger.active()).toHaveLength(2);
    const drop = ledger.active()[0]!;
    const o = (await call(alice, 'GET', '/agents/me/observe')).json();
    expect(o.drops[0]).not.toHaveProperty('exact');
    expect(Math.hypot(o.drops[0].hint.x - drop.x, o.drops[0].hint.z - drop.z)).toBeLessThanOrEqual(40);

    // Bring Alice's animal to the drop (the route cost is the live layer's business, tested elsewhere).
    const avatar = live.avatars.get(agentIdFor(alice.publicKey))!;
    expect(host.world.placeControlled(avatar.animalId, { x: drop.x + 1, z: drop.z, heading: 0 })).toBe(true);
    avatar.x = drop.x + 1; avatar.z = drop.z;
    live.tick(0.1);
    expect(ledger.active().find((d) => d.id === drop.id)!.spottedBy).toBe(avatar.agentId);
    expect((await call(alice, 'POST', '/agents/me/open', { dropId: drop.id })).json()).toEqual({ error: 'possess_longer_first' });
    avatar.since -= 6 * 60_000;
    expect((await call(alice, 'POST', '/agents/me/open', { dropId: drop.id })).json()).toEqual({ ok: true, seconds: 5 });
    for (let i = 0; i < OPEN_SECONDS * 10 + 2; i++) live.tick(0.1);
    for (let i = 0; i < 50 && !live.notices(avatar.agentId).some((n) => n.text.includes('won')); i++) await new Promise((r) => setTimeout(r, 20));
    expect(live.notices(avatar.agentId).at(-1)!.text).toContain('won 2.5 USDC');
    const claim = (await pool!.query("select wallet, agent_id, status from reward_claims where drop_id=$1", [drop.id])).rows[0];
    expect(claim).toEqual({ wallet: privateKeyToAccount(`0x${'2'.repeat(64)}`).address.toLowerCase(), agent_id: avatar.agentId, status: 'reserved' });
    expect((await pool!.query('select status from reward_drops where id=$1', [drop.id])).rows[0].status).toBe('reserved');
    // The admin panel sees it like any other reservation.
    const board = (await api.inject({ url: '/admin/rewards', headers: { authorization: admin.authorization } })).json();
    expect(board.drops.find((d: { id: string }) => d.id === drop.id)).toMatchObject({ kind: 'place', status: 'reserved' });
    // A second drop within the cooldown is refused before any open starts.
    const other = ledger.active()[0]!;
    host.world.placeControlled(avatar.animalId, { x: other.x, z: other.z, heading: 0 }); avatar.x = other.x; avatar.z = other.z;
    expect((await call(alice, 'POST', '/agents/me/open', { dropId: other.id })).json()).toEqual({ error: 'cooldown' });
    expect((await call(bob, 'POST', '/agents/me/open', { dropId: other.id })).json()).toEqual({ error: 'not_possessing' });
  });

  it('saves possessions and restores them after a restart', async () => {
    await deps.store.savePossessions(host.worldId!, live.avatars.values());
    const saved = await deps.store.loadPossessions(host.worldId!);
    expect(saved.map((s) => s.agentId)).toEqual([agentIdFor(alice.publicKey)]);
    const again = new LiveLayer(worldPort(() => host.world, () => host.worldId));
    expect(again.restore(saved[0]!)).toBe(true);
    expect(again.avatars.get(saved[0]!.agentId)!.animalId).toBe(saved[0]!.animalId);
    expect((await call(alice, 'POST', '/agents/me/release')).json()).toEqual({ ok: true });
    expect(host.world.animal(saved[0]!.animalId)!.controller).toBeUndefined();
  });

  it('ranks agents by drops won, then their longest life with one animal', async () => {
    const aliceId = agentIdFor(alice.publicKey), bobId = agentIdFor(bob.publicKey);
    for (let i = 0; i < 50 && !(await pool!.query('select 1 from live_lives where agent_id=$1', [aliceId])).rowCount; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await pool!.query('select how from live_lives where agent_id=$1', [aliceId])).rows).toEqual([{ how: 'released' }]);
    const now = Date.now();
    await deps.store.recordLife({ agentId: bobId, animalId: 'sambar_0001', speciesId: 'sambar', since: now - 600_000, endedAt: now - 60_000, how: 'caught' });
    expect((await call(bob, 'POST', '/agents/me/possess', { speciesId: 'sambar' })).statusCode).toBe(200);
    live.avatars.get(bobId)!.since = now - 900_000;

    const board = (await api.inject('/agents/leaderboard')).json();
    expect(board.agents).toEqual([
      { agentId: aliceId, name: 'Sora', drops: 1, usdcMicro: '2500000', usdc: '2.500000', longestLifeSeconds: expect.any(Number), animalsLost: 0, playing: false },
      { agentId: bobId, name: expect.any(String), drops: 0, usdcMicro: '0', usdc: '0.000000', longestLifeSeconds: expect.any(Number), animalsLost: 1, playing: true },
    ]);
    expect(board.agents[0].longestLifeSeconds).toBeGreaterThanOrEqual(360);
    // Bob's current sambar (15 minutes) beats his earlier life (9 minutes).
    expect(board.agents[1].longestLifeSeconds).toBeGreaterThanOrEqual(900);
    expect(board.agents[1].longestLifeSeconds).toBeLessThan(960);
    // A win stays on the board once its payment is verified on-chain.
    await pool!.query("update reward_claims set status='verified_paid' where agent_id=$1", [aliceId]);
    const verified = await deps.store.leaderboard(live.avatars.values(), Date.now());
    expect(verified.find((r) => r.agentId === aliceId)).toMatchObject({ drops: 1, usdcMicro: '2500000' });
  });

  it('lets an agent say a line that nearby agents hear, and lets the operator mute it', async () => {
    const aliceId = agentIdFor(alice.publicKey), bobId = agentIdFor(bob.publicKey);
    for (let i = 0; i < 30 && (await call(alice, 'POST', '/agents/me/possess', { speciesId: 'chital' })).statusCode !== 200; i++) live.tick(0.1);
    const bobAt = live.avatars.get(bobId)!, aliceAvatar = live.avatars.get(aliceId)!;
    aliceAvatar.x = bobAt.x + 20; aliceAvatar.z = bobAt.z;
    await new Promise((r) => setTimeout(r, 2100)); // Let the command rate limit refill after the tests above.

    expect((await call(alice, 'POST', '/agents/me/say', { text: 'visit www.free-usdc.xyz' })).json()).toEqual({ error: 'no_links' });
    expect((await call(alice, 'POST', '/agents/me/say', { text: 'Fresh water to the east' })).json()).toEqual({ ok: true });
    const heard = (await call(bob, 'GET', '/agents/me/observe')).json();
    expect(heard.heard).toEqual([expect.objectContaining({ from: 'Sora', agentId: aliceId, text: 'Fresh water to the east', distance: 20 })]);
    expect(heard.untrusted).toContain('heard');

    const admin = { authorization: `Bearer ${rewards.adminToken}`, 'content-type': 'application/json' };
    expect((await api.inject({ method: 'POST', url: '/admin/rewards/agents/mute', payload: JSON.stringify({ agent: 'Sora', muted: true }) })).statusCode).toBe(401);
    const muted = await api.inject({ method: 'POST', url: '/admin/rewards/agents/mute', headers: admin, payload: JSON.stringify({ agent: 'sora', muted: true }) });
    expect(muted.json()).toEqual({ agentId: aliceId, muted: true });
    expect((await call(bob, 'GET', '/agents/me/observe')).json().heard).toEqual([]);
    expect((await call(alice, 'POST', '/agents/me/say', { text: 'Still here' })).json()).toEqual({ error: 'muted' });
    expect((await api.inject({ method: 'POST', url: '/admin/rewards/agents/mute', headers: admin, payload: JSON.stringify({ agent: 'Nobody', muted: true }) })).statusCode).toBe(404);
  });

  it('can ask agents to hold a token: proven at registration, checked again to take an animal', async () => {
    const rich = privateKeyToAccount(`0x${'3'.repeat(64)}`), poor = privateKeyToAccount(`0x${'4'.repeat(64)}`);
    const balances = new Map<string, bigint>([[rich.address.toLowerCase(), 10n]]);
    const holding = { minAtomic: 5n, tokenAddress: '0x' + '5'.repeat(40), chainId: 8453,
      balance: async (w: string) => balances.get(w.toLowerCase()) ?? 0n };
    const gated = buildApi({ host, pool: pool!, rewards, live: { ...deps, holding, limits: { slots: 10, perNetworkPerDay: 10 }, spot: () => randomLandSpot(host.world) } });
    await gated.ready();
    try {
      const send = (k: ReturnType<typeof keypair>, method: string, path: string, body?: unknown) => {
        const raw = body === undefined ? '' : JSON.stringify(body);
        return gated.inject({ method, url: path, headers: signedHeaders(k, audience, method, path, raw), ...(raw ? { payload: raw } : {}) });
      };
      expect((await gated.inject('/agents/info')).json().holding).toEqual({ tokenAddress: holding.tokenAddress, chainId: 8453, minAtomic: '5' });
      const dan = keypair(), danId = agentIdFor(dan.publicKey);
      const bare = await send(dan, 'POST', '/agents/register', { name: 'Dan' });
      expect(bare.statusCode).toBe(400);
      expect(bare.json()).toMatchObject({ error: 'holding_wallet_required', message: expect.stringContaining(`Agent: ${danId}`) });
      const proof = (a: typeof rich, id = danId) => a.signMessage({ message: walletProofMessage(id, a.address, audience) });
      expect((await send(dan, 'POST', '/agents/register', { name: 'Dan', wallet: rich.address, signature: await proof(poor) })).json().error).toBe('wallet_signature_invalid');
      expect((await send(dan, 'POST', '/agents/register', { name: 'Dan', wallet: poor.address, signature: await proof(poor) })).json()).toEqual({ error: 'holding_below_minimum' });
      expect((await send(dan, 'POST', '/agents/register', { name: 'Dan', wallet: rich.address, signature: await proof(rich) })).json()).toMatchObject({ agentId: danId, created: true });
      expect(await deps.store.byId(danId)).toMatchObject({ wallet: rich.address.toLowerCase(), walletProven: true });
      // One agent per wallet.
      const eve = keypair();
      expect((await send(eve, 'POST', '/agents/register', { name: 'Eve', wallet: rich.address, signature: await proof(rich, agentIdFor(eve.publicKey)) })).statusCode).toBe(409);

      expect((await send(dan, 'POST', '/agents/me/possess', { speciesId: 'sambar' })).statusCode).toBe(200);
      expect((await send(dan, 'POST', '/agents/me/release')).json()).toEqual({ ok: true });
      // Alice's proven wallet holds none of the token, so she cannot take an animal here.
      expect((await send(alice, 'POST', '/agents/me/possess', { speciesId: 'chital' })).json()).toEqual({ error: 'holding_below_minimum' });
      // Balances are re-read after ten minutes: Dan sold his tokens.
      balances.set(rich.address.toLowerCase(), 0n);
      const later = Date.now() + 11 * 60_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
      try { expect((await send(dan, 'POST', '/agents/me/possess', { speciesId: 'sambar' })).json()).toEqual({ error: 'holding_below_minimum' }); }
      finally { clock.mockRestore(); }
    } finally { await gated.close(); }
  });

  it('starts an open only for the animal the eligibility check was made for', async () => {
    // Security review 5 October 2026: the five-minute check awaited the database, and a release
    // and possess landing meanwhile let an animal taken a moment ago start the open.
    const aliceId = agentIdFor(alice.publicKey);
    const admin = { authorization: `Bearer ${rewards.adminToken}`, 'content-type': 'application/json' };
    const batch = { batchId: randomUUID(), amount: '1', count: 1, spacingMinutes: 0, lifetimeMinutes: 30 };
    const created = await api.inject({ method: 'POST', url: '/admin/rewards/place-drops', headers: admin, payload: JSON.stringify(batch) });
    await ledger.refresh();
    const drop = ledger.active().find((d) => d.id === created.json().ids[0])!;
    if (!live.avatars.has(aliceId)) expect(live.possess(aliceId, 'Sora', { speciesId: 'chital' }).ok).toBe(true);
    const held = live.avatars.get(aliceId)!;
    held.since -= 10 * 60_000; // Long enough with this animal to open.
    const fresh = host.world.possessionCandidates('chital', 20).find((a) => a.id !== held.animalId && !live.wild.has(a.id))!;
    const blocker = vi.spyOn(ledger, 'blocker').mockImplementationOnce(async () => {
      live.release(aliceId);
      expect(live.possess(aliceId, 'Sora', { animalId: fresh.id }).ok).toBe(true);
      const swapped = live.avatars.get(aliceId)!;
      expect(host.world.placeControlled(swapped.animalId, { x: drop.x, z: drop.z, heading: 0 })).toBe(true);
      swapped.x = drop.x; swapped.z = drop.z;
      return null;
    });
    try {
      expect((await call(alice, 'POST', '/agents/me/open', { dropId: drop.id })).json()).toEqual({ error: 'possession_changed' });
      expect(live.avatars.get(aliceId)!.opening).toBeNull();
    } finally { blocker.mockRestore(); }
  });

  it('reports a wallet taken by a concurrent change as taken, not as a server error', async () => {
    const [first, second] = (await pool!.query<{ id: string }>('select id from live_agents where wallet is null order by id limit 2')).rows;
    const wallet = `0x${'6'.repeat(40)}`;
    const held = await pool!.connect();
    try {
      await held.query('begin');
      await held.query('update live_agents set wallet=$2, wallet_proven=true where id=$1', [first!.id, wallet]);
      // Sees no owner yet, so it goes on to wait at the unique index until the first change commits.
      const racing = deps.store.setWallet(second!.id, wallet);
      await new Promise((r) => setTimeout(r, 100));
      await held.query('commit');
      await expect(racing).resolves.toBe('wallet_taken');
    } finally { held.release(); }
  });

  it('counts registrations from one IPv6 /64 against one network', async () => {
    // Security review 5 October 2026: each address of a /64 used to be a network of its own.
    const limited = buildApi({ host, pool: pool!, rewards, live: { ...deps, limits: { slots: 50, perNetworkPerDay: 2 }, spot: () => randomLandSpot(host.world) } });
    await limited.ready();
    try {
      const register = (n: number, remoteAddress: string) => {
        const k = keypair(), raw = JSON.stringify({ name: `Six ${n}` });
        return limited.inject({ method: 'POST', url: '/agents/register', remoteAddress, payload: raw,
          headers: signedHeaders(k, audience, 'POST', '/agents/register', raw) });
      };
      expect((await register(1, '2001:db8:42:1::a')).statusCode).toBe(200);
      expect((await register(2, '2001:db8:42:1::b')).statusCode).toBe(200);
      expect((await register(3, '2001:db8:42:1:ffff::c')).json()).toEqual({ error: 'network_daily_limit' });
      expect((await register(4, '2001:db8:42:2::a')).statusCode).toBe(200);
    } finally { await limited.close(); }
  });
});
