import type { Pool } from '../db/pool.js';
import type { Creators } from '../challenges/routes.js';
import type { AgentStore } from '../live/liveStore.js';
import type { HumanSessions } from '../live/routes.js';
import type { AccountsConfig } from './config.js';
import { cookie } from './cookies.js';
import { SESSION_COOKIE, type AccountRouteDeps } from './routes.js';
import { AccountStore } from './store.js';
import { xAuth } from './xAuth.js';

/**
 * Accounts beside the live layer (spec §14): the sign-in routes, the signed-in person behind a
 * /play request, and the signed-in creator behind a challenge draft. Wallets are linked on the
 * challenges' chain; without challenges there is nothing to link a wallet for.
 */
export function accountsRuntime(config: AccountsConfig, deps: { pool: Pool; agents: AgentStore; chainId?: number | undefined; clock?: () => number }):
  { routes: AccountRouteDeps; humans: HumanSessions; creators: Creators } {
  const store = new AccountStore(deps.pool, deps.agents, deps.clock);
  const signedIn = (req: Parameters<HumanSessions['account']>[0]) => store.fromSession(cookie(req, SESSION_COOKIE));
  return {
    routes: { config, store, x: xAuth(config), ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.chainId ? { wallet: { chainId: deps.chainId } } : {}) },
    humans: { origin: config.origin, async account(req) {
      const a = await signedIn(req);
      return a ? { agentId: a.agentId, xAccountDays: store.xAccountDays(a) } : null;
    } },
    creators: { origin: config.origin, async account(req) {
      const a = await signedIn(req);
      if (!a) return null;
      const agent = await deps.agents.byId(a.agentId);
      return { accountId: a.id, wallet: agent?.walletProven ? agent.wallet : null, xAccountDays: store.xAccountDays(a) };
    }, draftsToday: (accountId) => store.draftsToday(accountId) },
  };
}
