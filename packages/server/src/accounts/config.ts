/**
 * Wildsentia accounts (docs/2026-10-09-challenges-design.md §14): people sign in with X. Off
 * unless every setting is present; a partial set is an error. The site's origin is the redirect
 * URI's, and cookies are Secure unless that is plain http on this machine.
 */
export interface AccountsConfig { clientId: string; clientSecret: string; redirectUri: string; origin: string; secure: boolean }

const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1';

export function accountsConfig(env: NodeJS.ProcessEnv): AccountsConfig | undefined {
  const names = ['VANA_X_CLIENT_ID', 'VANA_X_CLIENT_SECRET', 'VANA_X_REDIRECT_URI'] as const;
  if (names.every((n) => !env[n]?.trim())) return undefined;
  if (names.some((n) => !env[n]?.trim())) throw new Error('Incomplete X sign-in configuration (VANA_X_CLIENT_ID, VANA_X_CLIENT_SECRET, VANA_X_REDIRECT_URI)');
  const clientId = env.VANA_X_CLIENT_ID!.trim(), clientSecret = env.VANA_X_CLIENT_SECRET!.trim();
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(clientId)) throw new Error('Invalid VANA_X_CLIENT_ID');
  if (clientSecret.length < 8 || /\s/.test(clientSecret)) throw new Error('Invalid VANA_X_CLIENT_SECRET');
  let redirect: URL;
  try { redirect = new URL(env.VANA_X_REDIRECT_URI!.trim()); } catch { throw new Error('Invalid VANA_X_REDIRECT_URI'); }
  const local = redirect.protocol === 'http:' && loopback(redirect.hostname);
  if ((redirect.protocol !== 'https:' && !local) || redirect.username || redirect.password || redirect.search || redirect.hash
    || !redirect.pathname.endsWith('/accounts/x/callback')) throw new Error('Invalid VANA_X_REDIRECT_URI');
  return { clientId, clientSecret, redirectUri: redirect.href, origin: redirect.origin, secure: !local };
}
