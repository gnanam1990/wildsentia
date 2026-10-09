import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AccountsConfig } from './config.js';
import { cookie, cookieHeader, sameOriginJson } from './cookies.js';
import { CREATES_PER_DAY, MIN_X_ACCOUNT_DAYS, SESSION_DAYS, type Account, type AccountStore } from './store.js';
import type { XAuth } from './xAuth.js';

export const SESSION_COOKIE = 'ws_session';
const OAUTH_COOKIE = 'ws_oauth';
const STATE_MS = 10 * 60_000;
const MAX_PENDING = 5000;

export interface AccountRouteDeps { config: AccountsConfig; store: AccountStore; x: XAuth; clock?: () => number }

/** What the signed-in person can do, and what they still need (spec §6 and §14). */
export async function accountView(store: AccountStore, a: Account) {
  const agent = await store.agents.byId(a.agentId);
  const wallet = agent?.walletProven ? agent.wallet : null;
  const days = store.xAccountDays(a);
  const needs = [...(days < MIN_X_ACCOUNT_DAYS ? ['x_account_30_days'] : []), ...(wallet ? [] : ['wallet'])];
  const left = Math.max(0, CREATES_PER_DAY - await store.draftsToday(a.id));
  return { handle: a.handle, name: a.name, xAccountDays: days, agentId: a.agentId, playerName: agent?.name ?? a.handle, wallet,
    canCreate: needs.length === 0 && left > 0, canPlay: needs.length === 0, createsLeftToday: left, needs };
}

/** X sign-in, the session cookie, and who is signed in. */
export function installAccounts(app: FastifyInstance, deps: AccountRouteDeps): void {
  const { config, store, x } = deps;
  const clock = deps.clock ?? Date.now;
  const pending = new Map<string, { verifier: string; expires: number }>();
  const done = (signin?: 'failed') => `${config.origin}/challenges.html${signin ? '?signin=failed' : ''}`;

  app.addHook('onRequest', async (req, reply) => {
    if (!/^\/accounts(\/|$)/.test(req.routeOptions.url ?? '')) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!sameOriginJson(req, reply, config.origin)) return reply;
  });

  app.get('/accounts/x/start', async (_req, reply) => {
    const now = clock();
    for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
    if (pending.size >= MAX_PENDING) return reply.code(503).send({ error: 'busy' });
    const state = randomBytes(18).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    pending.set(state, { verifier, expires: now + STATE_MS });
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    // The state is bound to this browser, so a sign-in link sent by someone else cannot sign it in as them.
    reply.header('set-cookie', cookieHeader(OAUTH_COOKIE, state, { maxAgeSeconds: STATE_MS / 1000, secure: config.secure }));
    return reply.redirect(x.authorizeUrl({ state, codeChallenge: challenge }), 302);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/accounts/x/callback', async (req, reply) => {
    const clear = cookieHeader(OAUTH_COOKIE, '', { maxAgeSeconds: 0, secure: config.secure });
    const state = req.query.state ?? '';
    // Only this browser's own state counts, and it is used up once used.
    const mine = state !== '' && cookie(req, OAUTH_COOKIE) === state;
    const entry = mine ? pending.get(state) : undefined;
    if (entry) pending.delete(state);
    if (req.query.error || !req.query.code || !entry || entry.expires <= clock()) {
      reply.header('set-cookie', clear);
      return reply.redirect(done('failed'), 302);
    }
    try {
      const user = await x.signIn(req.query.code, entry.verifier);
      const { token } = await store.signIn(user);
      reply.header('set-cookie', [clear, cookieHeader(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_DAYS * 86_400, secure: config.secure })]);
      return reply.redirect(done(), 302);
    } catch (error) {
      console.error('[accounts] X sign-in failed:', (error as Error).message.slice(0, 120));
      reply.header('set-cookie', clear);
      return reply.redirect(done('failed'), 302);
    }
  });

  app.get('/accounts/me', async (req, reply) => {
    const a = await store.fromSession(cookie(req, SESSION_COOKIE));
    if (!a) return reply.code(401).send({ error: 'signed_out' });
    return { account: await accountView(store, a) };
  });

  app.post('/accounts/logout', async (req, reply) => {
    await store.signOut(cookie(req, SESSION_COOKIE));
    reply.header('set-cookie', cookieHeader(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: config.secure }));
    return { ok: true };
  });
}
