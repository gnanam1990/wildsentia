import type { AccountsConfig } from './config.js';

/** What the server learns about a person from X, once, at sign-in. */
export interface XUser { id: string; username: string; name: string; createdAt: Date }

/** X OAuth 2.0 with PKCE. A port, so tests use a fake X. */
export interface XAuth {
  authorizeUrl(p: { state: string; codeChallenge: string }): string;
  /** Swaps the code for a token, reads who signed in, then revokes the token: nothing is kept that could act as them. */
  signIn(code: string, codeVerifier: string): Promise<XUser>;
}

const SCOPE = 'users.read tweet.read';

export function xAuth(config: AccountsConfig, fetchImpl: typeof fetch = fetch): XAuth {
  const basic = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  const form = (fields: Record<string, string>) => ({ method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(10_000) });
  return {
    authorizeUrl({ state, codeChallenge }) {
      const url = new URL('https://x.com/i/oauth2/authorize');
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri,
        scope: SCOPE, state, code_challenge: codeChallenge, code_challenge_method: 'S256' })) url.searchParams.set(k, v);
      return url.href;
    },
    async signIn(code, codeVerifier) {
      // Error bodies and statuses are reported; the secret and tokens never are.
      const tokenRes = await fetchImpl('https://api.x.com/2/oauth2/token', form({ grant_type: 'authorization_code', code,
        redirect_uri: config.redirectUri, code_verifier: codeVerifier, client_id: config.clientId }));
      if (!tokenRes.ok) throw new Error(`x_token_failed: ${tokenRes.status}`);
      const token = (await tokenRes.json() as { access_token?: unknown }).access_token;
      if (typeof token !== 'string' || !token) throw new Error('x_token_failed: no token');
      try {
        const meRes = await fetchImpl('https://api.x.com/2/users/me?user.fields=created_at',
          { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        if (!meRes.ok) throw new Error(`x_user_failed: ${meRes.status}`);
        const d = (await meRes.json() as { data?: Record<string, unknown> }).data ?? {};
        const createdAt = new Date(String(d.created_at));
        if (typeof d.id !== 'string' || !/^[0-9]{1,30}$/.test(d.id) || typeof d.username !== 'string' || Number.isNaN(createdAt.getTime()))
          throw new Error('x_user_failed: unexpected answer');
        return { id: d.id, username: d.username.slice(0, 50), name: typeof d.name === 'string' ? d.name.slice(0, 100) : d.username, createdAt };
      } finally {
        await fetchImpl('https://api.x.com/2/oauth2/revoke', form({ token, token_type_hint: 'access_token', client_id: config.clientId }))
          .catch(() => undefined);
      }
    },
  };
}
