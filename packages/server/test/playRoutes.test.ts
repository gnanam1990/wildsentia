import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createWorld, type World } from '@vana/sim';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { AgentStore, type AgentRecord } from '../src/live/liveStore.js';
import { installLiveAgents } from '../src/live/routes.js';
import { signingString } from '../src/live/signing.js';
import type { AcceptResult } from '../src/challenges/engine.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

const ORIGIN = 'https://wildsentia.test';
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

maybe('play: a signed-in person steering an animal', () => {
  let app: FastifyInstance, world: World, live: LiveLayer, human: AgentRecord, days: number, now: number;
  const accept = vi.fn(async (): Promise<AcceptResult> => ({ ok: true, queued: false, attemptId: 'att-1', animalId: 'chital_1' }));
  const leave = vi.fn(() => true);
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate live_possessions, live_agents cascade');
    world = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { chital: 10, tiger: 1 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    now = Date.now();
    live = new LiveLayer(port, null, () => now);
    const agents = new AgentStore(pool!);
    human = await agents.ensureHuman({ xUserId: '555', handle: 'tara', networkHash: 'n' });
    await agents.setWallet(human.id, '0x' + 'b'.repeat(40));
    days = 400;
    accept.mockClear();
    app = Fastify();
    installLiveAgents(app, { live, world: port, store: agents, ledger: null, limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's',
      clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)),
      challenges: { accept, progressOf: () => null, waitingOf: () => null, leave },
      humans: { origin: ORIGIN, account: async (req) => (req.headers.cookie === 'ws_session=good' ? { agentId: human.id, xAccountDays: days } : null) } });
    await app.ready();
  });

  const send = (method: 'GET' | 'POST', path: string, body?: object, headers: Record<string, string> = {}) => app.inject({ method, url: path,
    headers: { cookie: 'ws_session=good', origin: ORIGIN, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });

  it('plays with the same commands as an agent', async () => {
    expect((await send('GET', '/play/observe')).json()).toMatchObject({ you: { agentId: human.id, name: 'tara' }, animal: null });
    const taken = await send('POST', '/play/possess', { speciesId: 'chital' });
    expect(taken.json()).toMatchObject({ speciesId: 'chital' });
    const me = live.avatars.get(human.id)!;
    expect((await send('POST', '/play/move', { points: [{ x: me.x + 5, z: me.z }], gait: 'walk' })).json()).toEqual({ ok: true });
    expect((await send('POST', '/play/stop')).json()).toEqual({ ok: true });
    expect((await send('POST', '/play/act', { action: 'rest' })).json()).toEqual({ ok: true });
    expect((await send('POST', '/play/say', { text: 'Hello forest' })).json()).toEqual({ ok: true });
    expect((await send('GET', '/play/observe')).json().animal).toMatchObject({ speciesId: 'chital' });
    expect((await send('POST', '/play/hunt', { animalId: 'x' })).statusCode).toBe(409);
    expect((await send('POST', '/play/climb')).statusCode).toBe(409);
    expect((await send('POST', '/play/challenges/7/accept')).json()).toEqual({ queued: false, attemptId: 'att-1', animalId: 'chital_1' });
    expect(accept).toHaveBeenCalledWith({ agentId: human.id, name: 'tara', wallet: '0x' + 'b'.repeat(40), walletProven: true }, 7);
    expect((await send('POST', '/play/challenges/leave')).json()).toEqual({ left: true });
    expect((await send('POST', '/play/release')).json()).toEqual({ ok: true });
  });

  it('keeps the animal while the page shows the person is there', async () => {
    await send('POST', '/play/possess', { speciesId: 'chital' });
    const me = live.avatars.get(human.id)!;
    now += 14 * 60_000;
    expect((await send('POST', '/play/presence')).json()).toEqual({ ok: true });
    expect(me.lastCommand).toBe(now);
    now += 14 * 60_000;
    live.tick(0.1);
    expect(live.avatars.has(human.id)).toBe(true);
    await send('POST', '/play/release');
    expect((await send('POST', '/play/presence')).statusCode).toBe(409);
  });

  it('refuses a cross-site, wrong-origin or non-JSON command, and anyone signed out', async () => {
    expect((await send('POST', '/play/possess', { speciesId: 'chital' }, { origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await send('POST', '/play/possess', { speciesId: 'chital' }, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/play/possess', headers: { cookie: 'ws_session=good', 'content-type': 'text/plain' },
      payload: 'speciesId=chital' })).statusCode).toBe(415);
    expect((await send('GET', '/play/observe', undefined, { cookie: 'ws_session=other' })).statusCode).toBe(401);
    expect(live.avatars.has(human.id)).toBe(false);
  });

  it('accepts a challenge only from an X account at least 30 days old', async () => {
    days = 29;
    expect((await send('POST', '/play/challenges/7/accept')).json()).toEqual({ error: 'x_account_too_new' });
    expect(accept).not.toHaveBeenCalled();
  });

  it('has no wallet or drop commands: a person links a wallet through their account, and place drops are for agents', async () => {
    expect((await send('POST', '/play/wallet', { wallet: '0x' + 'c'.repeat(40) })).statusCode).toBe(404);
    expect((await send('POST', '/play/open', { dropId: 'd' })).statusCode).toBe(404);
  });

  it('have no key, so no signed request can act as them', async () => {
    // A request signed with any key is unknown unless that key registered: a person's identity has none.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = publicKey.export({ format: 'jwk' }).x!;
    const timestamp = String(Date.now()), nonce = randomBytes(18).toString('base64url');
    const signature = sign(null, Buffer.from(signingString({ audience: 'vana:w1', method: 'GET', path: '/agents/me/observe', timestamp, nonce, body: '' })), privateKey)
      .toString('base64url');
    const res = await app.inject({ url: '/agents/me/observe', headers: { 'x-vana-key': key, 'x-vana-timestamp': timestamp, 'x-vana-nonce': nonce, 'x-vana-signature': signature } });
    expect(res.json()).toEqual({ error: 'not_registered' });
  });

  it('limits requests by network before looking up a session', async () => {
    const codes = await Promise.all(Array.from({ length: 80 }, (_, i) => send('GET', '/play/observe', undefined, { cookie: `ws_session=guess${i}` })));
    expect(codes.some((r) => r.statusCode === 429)).toBe(true);
  });
});
