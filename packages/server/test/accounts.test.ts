import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { AgentStore, humanAgentId } from '../src/live/liveStore.js';
import { accountsConfig } from '../src/accounts/config.js';
import { AccountStore, xOwnerOf } from '../src/accounts/store.js';
import { installAccounts } from '../src/accounts/routes.js';
import { liveNetworkHash } from '../src/network.js';
import { accountsRuntime } from '../src/accounts/runtime.js';
import { xAuth, type XAuth, type XUser } from '../src/accounts/xAuth.js';
import { privateKeyToAccount } from 'viem/accounts';
import { testDatabaseUrl } from './testDatabase.js';

const ORIGIN = 'https://wildsentia.test';
const env = { VANA_X_CLIENT_ID: 'client-id-123', VANA_X_CLIENT_SECRET: 'super-secret-value',
  VANA_X_REDIRECT_URI: `${ORIGIN}/api/accounts/x/callback` };

describe('accounts configuration', () => {
  it('is off unless all of it is set, and checks it', () => {
    expect(accountsConfig({})).toBeUndefined();
    expect(accountsConfig(env)).toEqual({ clientId: 'client-id-123', clientSecret: 'super-secret-value',
      redirectUri: `${ORIGIN}/api/accounts/x/callback`, origin: ORIGIN, secure: true });
    expect(() => accountsConfig({ VANA_X_CLIENT_ID: 'x' })).toThrow('Incomplete');
    expect(() => accountsConfig({ ...env, VANA_X_REDIRECT_URI: 'http://wildsentia.test/cb' })).toThrow('VANA_X_REDIRECT_URI');
    expect(accountsConfig({ ...env, VANA_X_REDIRECT_URI: 'http://localhost:5173/api/accounts/x/callback' })).toMatchObject({
      origin: 'http://localhost:5173', secure: false });
  });
});

describe('X OAuth client', () => {
  it('asks X for the code with PKCE, swaps it with the client secret, reads the user, then revokes the token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      const u = String(url);
      if (u.endsWith('/2/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', token_type: 'bearer' }));
      if (u.includes('/2/users/me')) return new Response(JSON.stringify({ data: { id: '42', username: 'kavya', name: 'Kavya', created_at: '2020-01-02T03:04:05.000Z' } }));
      if (u.endsWith('/2/oauth2/revoke')) return new Response('{}');
      return new Response('no', { status: 404 });
    };
    const x = xAuth(accountsConfig(env)!, fake as typeof fetch);
    const url = new URL(x.authorizeUrl({ state: 'st', codeChallenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', client_id: 'client-id-123', redirect_uri: env.VANA_X_REDIRECT_URI,
      scope: 'users.read tweet.read', state: 'st', code_challenge: 'ch', code_challenge_method: 'S256' });
    const user = await x.signIn('the-code', 'the-verifier');
    expect(user).toEqual({ id: '42', username: 'kavya', name: 'Kavya', createdAt: new Date('2020-01-02T03:04:05.000Z') });
    const token = calls[0]!;
    expect(token.url).toBe('https://api.x.com/2/oauth2/token');
    expect((token.init!.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('client-id-123:super-secret-value').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(String(token.init!.body)))).toEqual({ grant_type: 'authorization_code', code: 'the-code',
      redirect_uri: env.VANA_X_REDIRECT_URI, code_verifier: 'the-verifier', client_id: 'client-id-123' });
    expect(calls[1]!.url).toBe('https://api.x.com/2/users/me?user.fields=created_at');
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(calls[2]!.url).toBe('https://api.x.com/2/oauth2/revoke');
    const failing = xAuth(accountsConfig(env)!, (async () => new Response('{"error":"invalid_request"}', { status: 400 })) as typeof fetch);
    await expect(failing.signIn('c', 'v')).rejects.toThrow(/x_token_failed/);
  });
});

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

/** A fake X: the user it signs in is set per test. */
function fakeX(user: () => XUser): XAuth & { codes: string[] } {
  const codes: string[] = [];
  return { codes, authorizeUrl: ({ state, codeChallenge }) => `https://x.com/i/oauth2/authorize?state=${state}&code_challenge=${codeChallenge}`,
    signIn: async (code) => { codes.push(code); if (code === 'bad') throw new Error('x_token_failed: 400'); return user(); } };
}
const cookieOf = (res: { headers: Record<string, unknown> }, name: string): string | undefined => {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw as string[] : raw ? [String(raw)] : [];
  return list.find((c) => c.startsWith(`${name}=`));
};
const valueOf = (cookie: string | undefined) => cookie?.split(';')[0]!.split('=')[1] ?? '';

maybe('accounts', () => {
  let app: FastifyInstance, now: number, user: XUser, x: ReturnType<typeof fakeX>, accounts: AccountStore;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate account_sessions, accounts, live_agents cascade');
    now = Date.parse('2026-10-10T00:00:00Z');
    user = { id: '777', username: 'kavya_k', name: 'Kavya', createdAt: new Date('2025-01-01T00:00:00Z') };
    x = fakeX(() => user);
    accounts = new AccountStore(pool!, new AgentStore(pool!), () => now);
    app = Fastify();
    installAccounts(app, { config: accountsConfig(env)!, store: accounts, x, clock: () => now, wallet: { chainId: 5042002 } });
    await app.ready();
  });

  const signIn = async () => {
    const start = await app.inject('/accounts/x/start');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const oauth = valueOf(cookieOf(start, '__Host-ws_oauth'));
    const back = await app.inject({ url: `/accounts/x/callback?code=good&state=${state}`, headers: { cookie: `__Host-ws_oauth=${oauth}` } });
    return { start, back, session: valueOf(cookieOf(back, '__Host-ws_session')) };
  };

  it('starts the X sign-in with PKCE and a state bound to this browser', async () => {
    const { start } = await signIn();
    expect(start.statusCode).toBe(302);
    const to = new URL(start.headers.location as string);
    expect(to.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(to.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieOf(start, '__Host-ws_oauth')).toMatch(/HttpOnly/);
    expect(cookieOf(start, '__Host-ws_oauth')).toMatch(/SameSite=Lax/);
    expect(cookieOf(start, '__Host-ws_oauth')).toMatch(/Secure/);
  });

  it('signs a person in: their account, their live identity, and a session of which only the hash is kept', async () => {
    const { back, session } = await signIn();
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`${ORIGIN}/challenges.html`);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieOf(back, '__Host-ws_session')).toMatch(/HttpOnly; .*SameSite=Lax/);
    expect(cookieOf(back, '__Host-ws_oauth')).toMatch(/Max-Age=0/);
    const { rows } = await pool!.query('select token_hash from account_sessions');
    expect(rows).toEqual([{ token_hash: createHash('sha256').update(session).digest('hex') }]);
    const me = (await app.inject({ url: '/accounts/me', headers: { cookie: `__Host-ws_session=${session}` } })).json();
    expect(me).toEqual({ account: { handle: 'kavya_k', name: 'Kavya', xAccountDays: 647, agentId: humanAgentId('777'), playerName: 'kavya_k',
      wallet: null, canCreate: false, canPlay: false, createsLeftToday: 3, needs: ['wallet'] } });
    expect(JSON.stringify(me)).not.toMatch(/super-secret|client-id/);
  });

  it("keeps the person's live identity under the keyed hash of the network they signed in from", async () => {
    await app.close();
    app = Fastify();
    installAccounts(app, { config: accountsConfig(env)!, store: accounts, x, clock: () => now, networkSecret: 'live-secret' });
    await app.ready();
    await signIn();
    // Fastify's inject comes from 127.0.0.1: the same hash an agent registering from there gets.
    expect(await accounts.agents.networkOf(humanAgentId('777'))).toBe(liveNetworkHash('live-secret', '127.0.0.1'));
  });

  it("refuses a callback whose state is not this browser's", async () => {
    const start = await app.inject('/accounts/x/start');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    // Someone else's state (a link sent to the victim) without the matching cookie.
    const forged = await app.inject({ url: `/accounts/x/callback?code=good&state=${state}` });
    expect(forged.headers.location).toBe(`${ORIGIN}/challenges.html?signin=failed`);
    expect(cookieOf(forged, '__Host-ws_session')).toBeUndefined();
    expect(x.codes).toEqual([]);
    // A state is good once.
    const oauth = valueOf(cookieOf(start, '__Host-ws_oauth'));
    expect(cookieOf(await app.inject({ url: `/accounts/x/callback?code=good&state=${state}`, headers: { cookie: `__Host-ws_oauth=${oauth}` } }), '__Host-ws_session')).toBeDefined();
    expect(cookieOf(await app.inject({ url: `/accounts/x/callback?code=good&state=${state}`, headers: { cookie: `__Host-ws_oauth=${oauth}` } }), '__Host-ws_session')).toBeUndefined();
    // X refusing, or the person declining, ends in the same plain failure.
    const s2 = await app.inject('/accounts/x/start');
    const st2 = new URL(s2.headers.location as string).searchParams.get('state')!;
    const failed = await app.inject({ url: `/accounts/x/callback?code=bad&state=${st2}`, headers: { cookie: `__Host-ws_oauth=${valueOf(cookieOf(s2, '__Host-ws_oauth'))}` } });
    expect(failed.headers.location).toBe(`${ORIGIN}/challenges.html?signin=failed`);
    expect((await app.inject('/accounts/x/callback?error=access_denied&state=zzz')).headers.location).toBe(`${ORIGIN}/challenges.html?signin=failed`);
  });

  it('expires the sign-in state after ten minutes', async () => {
    const start = await app.inject('/accounts/x/start');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    now += 10 * 60_000 + 1;
    const late = await app.inject({ url: `/accounts/x/callback?code=good&state=${state}`, headers: { cookie: `__Host-ws_oauth=${valueOf(cookieOf(start, '__Host-ws_oauth'))}` } });
    expect(cookieOf(late, '__Host-ws_session')).toBeUndefined();
  });

  it('keeps one account per X user, refreshes its details, and mints a new session each time', async () => {
    const first = await signIn();
    user = { ...user, username: 'kavya_new', name: 'Kavya K' };
    const second = await signIn();
    expect(second.session).not.toBe(first.session);
    const { rows } = await pool!.query('select x_handle, x_name from accounts');
    expect(rows).toEqual([{ x_handle: 'kavya_new', x_name: 'Kavya K' }]);
    // A new X account (under 30 days) can neither play nor create.
    user = { id: '888', username: 'fresh', name: 'Fresh', createdAt: new Date(now - 29 * 86_400_000) };
    const fresh = await signIn();
    const me = (await app.inject({ url: '/accounts/me', headers: { cookie: `__Host-ws_session=${fresh.session}` } })).json();
    expect(me.account).toMatchObject({ xAccountDays: 29, canPlay: false, canCreate: false, needs: ['x_account_30_days', 'wallet'] });
  });

  it('names the owner a prize may be paid to: the X account playing an agent, once it is 30 days old', async () => {
    const { account } = await accounts.signIn(user);
    expect(await xOwnerOf(pool!, account.agentId, now)).toBe('x:777');
    // An account made 29 days ago is too new; an outside agent, or nobody, has no X owner.
    user = { ...user, id: '778', username: 'new_one', createdAt: new Date(now - 29 * 86_400_000) };
    const fresh = await accounts.signIn(user);
    expect(await xOwnerOf(pool!, fresh.account.agentId, now)).toBeNull();
    expect(await xOwnerOf(pool!, fresh.account.agentId, now + 86_400_000)).toBe('x:778');
    expect(await xOwnerOf(pool!, 'ag_outside', now)).toBeNull();
  });

  it('signs out, and refuses expired or unknown sessions', async () => {
    const { session } = await signIn();
    const out = await app.inject({ method: 'POST', url: '/accounts/logout', headers: { cookie: `__Host-ws_session=${session}`, 'content-type': 'application/json', origin: ORIGIN }, payload: '{}' });
    expect(out.json()).toEqual({ ok: true });
    expect(cookieOf(out, '__Host-ws_session')).toMatch(/Max-Age=0/);
    expect((await app.inject({ url: '/accounts/me', headers: { cookie: `__Host-ws_session=${session}` } })).statusCode).toBe(401);
    const again = await signIn();
    now += 30 * 86_400_000 + 1;
    expect((await app.inject({ url: '/accounts/me', headers: { cookie: `__Host-ws_session=${again.session}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/accounts/me', headers: { cookie: '__Host-ws_session=nonsense' } })).statusCode).toBe(401);
    expect((await app.inject('/accounts/me')).json()).toEqual({ error: 'signed_out' });
  });

  it('refuses cross-site or non-JSON changes', async () => {
    const { session } = await signIn();
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/accounts/logout', headers: { cookie: `__Host-ws_session=${session}`, ...headers }, payload: '{}' });
    expect((await post({ 'content-type': 'application/json', origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await post({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post({ 'content-type': 'text/plain' })).statusCode).toBe(415);
    expect((await app.inject({ url: '/accounts/me', headers: { cookie: `__Host-ws_session=${session}` } })).statusCode).toBe(200);
  });

  describe('wallet link', () => {
    const key = privateKeyToAccount(`0x${'4'.repeat(64)}`);
    const json = (session: string, payload: object) => ({ method: 'POST' as const, headers: { cookie: `__Host-ws_session=${session}`,
      'content-type': 'application/json', origin: ORIGIN }, payload: JSON.stringify(payload) });
    const link = async (session: string, signer = key) => {
      const c = await app.inject({ url: '/accounts/wallet/challenge', ...json(session, { address: key.address }) });
      const { message, nonce } = c.json();
      const signature = await signer.signMessage({ message });
      return { challenge: c.json(), verify: (over: object = {}) => app.inject({ url: '/accounts/wallet/verify',
        ...json(session, { address: key.address, nonce, signature, ...over }) }) };
    };

    it('links the wallet that signs the sign-in message for this site, once, within five minutes', async () => {
      const { session } = await signIn();
      const { challenge, verify } = await link(session);
      expect(challenge.message).toContain('wildsentia.test wants you to sign in with your Ethereum account:');
      expect(challenge.message).toContain(key.address);
      expect(challenge.message).toContain('Chain ID: 5042002');
      expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
      expect(challenge.message).toMatch(/payout wallet/);
      expect((await verify()).json()).toEqual({ wallet: key.address.toLowerCase() });
      expect((await verify()).statusCode).toBe(400); // used up
      const me = (await app.inject({ url: '/accounts/me', headers: { cookie: `__Host-ws_session=${session}` } })).json();
      expect(me.account).toMatchObject({ wallet: key.address.toLowerCase(), canPlay: true, canCreate: true, needs: [] });
    });

    it('refuses a signature by another key, a late one, and a signed-out request', async () => {
      const { session } = await signIn();
      const other = privateKeyToAccount(`0x${'5'.repeat(64)}`);
      expect((await (await link(session, other)).verify()).json()).toEqual({ error: 'wallet_signature_invalid' });
      const late = await link(session);
      now += 5 * 60_000 + 1;
      expect((await late.verify()).statusCode).toBe(400);
      expect((await app.inject({ url: '/accounts/wallet/challenge', ...json('nobody', { address: key.address }) })).statusCode).toBe(401);
      expect((await app.inject({ url: '/accounts/wallet/challenge', ...json(session, { address: '0x12' }) })).json()).toEqual({ error: 'invalid_address' });
    });

    it('refuses a body past its few fields before reading it (audit 17 November)', async () => {
      const { session } = await signIn();
      const big = { address: key.address, padding: 'x'.repeat(4096) };
      expect((await app.inject({ url: '/accounts/wallet/challenge', ...json(session, big) })).statusCode).toBe(413);
      expect((await app.inject({ url: '/accounts/wallet/verify', ...json(session, big) })).statusCode).toBe(413);
      expect((await app.inject({ url: '/accounts/logout', ...json(session, big) })).statusCode).toBe(413);
      // The real requests still fit.
      expect((await (await link(session)).verify()).json()).toEqual({ wallet: key.address.toLowerCase() });
    });

    it('refuses a wallet another player uses', async () => {
      const agents = new AgentStore(pool!);
      expect((await agents.register({ publicKey: 'D'.repeat(43), name: 'Bot', bio: '', networkHash: 'n', wallet: key.address.toLowerCase() },
        { slots: 5, perNetworkPerDay: 5 })).ok).toBe(true);
      const { session } = await signIn();
      expect((await (await link(session)).verify()).json()).toEqual({ error: 'wallet_taken' });
    });
  });

  it('gives the live routes and the challenge drafts the signed-in person behind a request', async () => {
    const { session } = await signIn();
    const runtime = accountsRuntime(accountsConfig(env)!, { pool: pool!, agents: new AgentStore(pool!), chainId: 5042002, clock: () => now });
    expect(runtime.routes.wallet).toEqual({ chainId: 5042002 });
    expect(runtime.humans.origin).toBe(ORIGIN);
    const req = (cookie: string) => ({ headers: { cookie } }) as never;
    expect(await runtime.humans.account(req(`__Host-ws_session=${session}`))).toEqual({ agentId: humanAgentId('777'), xAccountDays: 647 });
    expect(await runtime.humans.account(req('__Host-ws_session=nope'))).toBeNull();
    const creator = await runtime.creators.account(req(`a=1; __Host-ws_session=${session}`));
    expect(creator).toMatchObject({ wallet: null, xAccountDays: 647 });
    expect(await runtime.creators.draftsToday(creator!.accountId)).toBe(0);
  });

  describe('review fixes', () => {
    it('keeps no sign-in state on the server, so no flood of starts can block a sign-in', async () => {
      for (let i = 0; i < 6000; i++) await app.inject('/accounts/x/start');
      const { back, session } = await signIn();
      expect(back.headers.location).toBe(`${ORIGIN}/challenges.html`);
      expect(session).not.toBe('');
      // A state cookie altered by hand is refused.
      const start = await app.inject('/accounts/x/start');
      const state = new URL(start.headers.location as string).searchParams.get('state')!;
      const forged = valueOf(cookieOf(start, '__Host-ws_oauth')).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
      expect(cookieOf(await app.inject({ url: `/accounts/x/callback?code=good&state=${state}`, headers: { cookie: `__Host-ws_oauth=${forged}` } }),
        '__Host-ws_session')).toBeUndefined();
    });

    it('lets each account hold one wallet-link request at a time, so one account cannot block the others', async () => {
      const { session } = await signIn();
      const post = (s: string) => app.inject({ method: 'POST', url: '/accounts/wallet/challenge', headers: { cookie: `__Host-ws_session=${s}`,
        'content-type': 'application/json', origin: ORIGIN }, payload: JSON.stringify({ address: '0x' + '1'.repeat(40) }) });
      for (let i = 0; i < 6000; i++) await post(session);
      user = { id: '999', username: 'other', name: 'Other', createdAt: new Date('2020-01-01T00:00:00Z') };
      const other = await signIn();
      expect((await post(other.session)).statusCode).toBe(200);
    });

    it('treats a malformed cookie as signed out, not as a server error', async () => {
      expect((await app.inject({ url: '/accounts/me', headers: { cookie: '__Host-ws_session=%E0%A4%A' } })).statusCode).toBe(401);
    });

    it('uses the __Host- cookie prefix on https, and plain names on a local http site', async () => {
      const { back } = await signIn();
      expect(cookieOf(back, '__Host-ws_session')).toMatch(/Path=\/; .*Secure/);
      const local = Fastify();
      installAccounts(local, { config: accountsConfig({ ...env, VANA_X_REDIRECT_URI: 'http://localhost:5173/api/accounts/x/callback' })!, store: accounts, x,
        clock: () => now });
      expect(cookieOf(await local.inject('/accounts/x/start'), 'ws_oauth')).toBeDefined();
    });

    it('clears expired sessions when someone signs in', async () => {
      await signIn();
      now += 31 * 86_400_000;
      await signIn();
      expect((await pool!.query('select count(*)::int as n from account_sessions')).rows[0].n).toBe(1);
    });
  });
});
