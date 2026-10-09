import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { AgentStore, humanAgentId } from '../src/live/liveStore.js';
import { accountsConfig } from '../src/accounts/config.js';
import { AccountStore } from '../src/accounts/store.js';
import { installAccounts } from '../src/accounts/routes.js';
import { xAuth, type XAuth, type XUser } from '../src/accounts/xAuth.js';
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
    installAccounts(app, { config: accountsConfig(env)!, store: accounts, x, clock: () => now });
    await app.ready();
  });

  const signIn = async () => {
    const start = await app.inject('/accounts/x/start');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const oauth = valueOf(cookieOf(start, 'ws_oauth'));
    const back = await app.inject({ url: `/accounts/x/callback?code=good&state=${state}`, headers: { cookie: `ws_oauth=${oauth}` } });
    return { start, back, session: valueOf(cookieOf(back, 'ws_session')) };
  };

  it('starts the X sign-in with PKCE and a state bound to this browser', async () => {
    const { start } = await signIn();
    expect(start.statusCode).toBe(302);
    const to = new URL(start.headers.location as string);
    expect(to.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(to.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieOf(start, 'ws_oauth')).toMatch(/HttpOnly/);
    expect(cookieOf(start, 'ws_oauth')).toMatch(/SameSite=Lax/);
    expect(cookieOf(start, 'ws_oauth')).toMatch(/Secure/);
  });

  it('signs a person in: their account, their live identity, and a session of which only the hash is kept', async () => {
    const { back, session } = await signIn();
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`${ORIGIN}/challenges.html`);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieOf(back, 'ws_session')).toMatch(/HttpOnly; .*SameSite=Lax/);
    expect(cookieOf(back, 'ws_oauth')).toMatch(/Max-Age=0/);
    const { rows } = await pool!.query('select token_hash from account_sessions');
    expect(rows).toEqual([{ token_hash: createHash('sha256').update(session).digest('hex') }]);
    const me = (await app.inject({ url: '/accounts/me', headers: { cookie: `ws_session=${session}` } })).json();
    expect(me).toEqual({ account: { handle: 'kavya_k', name: 'Kavya', xAccountDays: 647, agentId: humanAgentId('777'), playerName: 'kavya_k',
      wallet: null, canCreate: false, canPlay: false, createsLeftToday: 3, needs: ['wallet'] } });
    expect(JSON.stringify(me)).not.toMatch(/super-secret|client-id/);
  });

  it("refuses a callback whose state is not this browser's", async () => {
    const start = await app.inject('/accounts/x/start');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    // Someone else's state (a link sent to the victim) without the matching cookie.
    const forged = await app.inject({ url: `/accounts/x/callback?code=good&state=${state}` });
    expect(forged.headers.location).toBe(`${ORIGIN}/challenges.html?signin=failed`);
    expect(cookieOf(forged, 'ws_session')).toBeUndefined();
    expect(x.codes).toEqual([]);
    // A state is good once.
    const oauth = valueOf(cookieOf(start, 'ws_oauth'));
    expect(cookieOf(await app.inject({ url: `/accounts/x/callback?code=good&state=${state}`, headers: { cookie: `ws_oauth=${oauth}` } }), 'ws_session')).toBeDefined();
    expect(cookieOf(await app.inject({ url: `/accounts/x/callback?code=good&state=${state}`, headers: { cookie: `ws_oauth=${oauth}` } }), 'ws_session')).toBeUndefined();
    // X refusing, or the person declining, ends in the same plain failure.
    const s2 = await app.inject('/accounts/x/start');
    const st2 = new URL(s2.headers.location as string).searchParams.get('state')!;
    const failed = await app.inject({ url: `/accounts/x/callback?code=bad&state=${st2}`, headers: { cookie: `ws_oauth=${valueOf(cookieOf(s2, 'ws_oauth'))}` } });
    expect(failed.headers.location).toBe(`${ORIGIN}/challenges.html?signin=failed`);
    expect((await app.inject('/accounts/x/callback?error=access_denied&state=zzz')).headers.location).toBe(`${ORIGIN}/challenges.html?signin=failed`);
  });

  it('expires the sign-in state after ten minutes', async () => {
    const start = await app.inject('/accounts/x/start');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    now += 10 * 60_000 + 1;
    const late = await app.inject({ url: `/accounts/x/callback?code=good&state=${state}`, headers: { cookie: `ws_oauth=${valueOf(cookieOf(start, 'ws_oauth'))}` } });
    expect(cookieOf(late, 'ws_session')).toBeUndefined();
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
    const me = (await app.inject({ url: '/accounts/me', headers: { cookie: `ws_session=${fresh.session}` } })).json();
    expect(me.account).toMatchObject({ xAccountDays: 29, canPlay: false, canCreate: false, needs: ['x_account_30_days', 'wallet'] });
  });

  it('signs out, and refuses expired or unknown sessions', async () => {
    const { session } = await signIn();
    const out = await app.inject({ method: 'POST', url: '/accounts/logout', headers: { cookie: `ws_session=${session}`, 'content-type': 'application/json', origin: ORIGIN }, payload: '{}' });
    expect(out.json()).toEqual({ ok: true });
    expect(cookieOf(out, 'ws_session')).toMatch(/Max-Age=0/);
    expect((await app.inject({ url: '/accounts/me', headers: { cookie: `ws_session=${session}` } })).statusCode).toBe(401);
    const again = await signIn();
    now += 30 * 86_400_000 + 1;
    expect((await app.inject({ url: '/accounts/me', headers: { cookie: `ws_session=${again.session}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/accounts/me', headers: { cookie: 'ws_session=nonsense' } })).statusCode).toBe(401);
    expect((await app.inject('/accounts/me')).json()).toEqual({ error: 'signed_out' });
  });

  it('refuses cross-site or non-JSON changes', async () => {
    const { session } = await signIn();
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/accounts/logout', headers: { cookie: `ws_session=${session}`, ...headers }, payload: '{}' });
    expect((await post({ 'content-type': 'application/json', origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await post({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post({ 'content-type': 'text/plain' })).statusCode).toBe(415);
    expect((await app.inject({ url: '/accounts/me', headers: { cookie: `ws_session=${session}` } })).statusCode).toBe(200);
  });
});
