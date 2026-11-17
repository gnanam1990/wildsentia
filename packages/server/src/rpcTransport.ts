import { fallback, http, type Transport } from 'viem';

/**
 * RPC transports that never write a key-bearing URL into an error. Every chain client the server
 * builds goes through here: the Arc bounties, Challenges and the holder check
 * (docs/2026-11-17-security-audit.md C2).
 */

/**
 * The RPC transport: one URL, or several separated by commas, tried in order (a dedicated provider
 * first and Arc's public RPC after it, which rate-limits: "Request exceeds defined limit").
 */
export function rpcTransport(rpcUrl: string, options: { timeout?: number; retryCount?: number } = {}) {
  const urls = rpcUrl.split(',').map((u) => u.trim()).filter(Boolean);
  if (!urls.length) throw new Error('no RPC URL');
  const one = (url: string) => hidingKey(url, http(url, { timeout: options.timeout ?? 15_000, retryCount: options.retryCount ?? 2 }));
  return urls.length === 1 ? one(urls[0]!) : fallback(urls.map(one));
}

/**
 * A managed RPC carries its key in the URL's path (Alchemy's `/v2/<key>`), and viem writes the URL
 * into its errors, which the server logs. Each error from this transport has the URL's path and
 * query replaced, so a log shows the host and never the key.
 */
function hidingKey(url: string, transport: Transport): Transport {
  let shown: string;
  try {
    const u = new URL(url);
    if (u.pathname === '/' && !u.search && !u.username && !u.password) return transport;
    shown = `${u.protocol}//${u.host}/…`;
  } catch { return transport; }
  return ((options: Parameters<Transport>[0]) => {
    const inner = transport(options);
    return { ...inner, request: (async (args: Parameters<typeof inner.request>[0]) => {
      try { return await inner.request(args); } catch (error) { throw redactUrl(error, url, shown); }
    }) as typeof inner.request };
  }) as Transport;
}

/**
 * The error and each cause, with every text naming `url` rewritten to name `shown`. viem may write
 * the URL normalised (its credentials stripped, its host lower-cased), so each form of it is
 * replaced, and then the secret pieces themselves (path with query, password) wherever they remain.
 */
export function redactUrl<T>(error: T, url: string, shown: string): T {
  const forms = new Set<string>([url]);
  try {
    const u = new URL(url);
    forms.add(u.href);
    const raw = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
    if (raw && raw !== '/') forms.add(raw);
    if (u.pathname !== '/' || u.search) forms.add(`${u.pathname}${u.search}`);
    if (u.password) forms.add(u.password);
    if (u.username || u.password) { u.username = ''; u.password = ''; forms.add(u.href); }
  } catch { /* not a URL: the string as given */ }
  const pieces = [...forms].filter((f) => f.length >= 4).sort((a, b) => b.length - a.length);
  const scrub = (v: unknown) => {
    if (typeof v !== 'string') return v;
    let out = v;
    for (const f of pieces) if (out.includes(f)) out = out.split(f).join(f.includes('://') ? shown : '/…');
    return out;
  };
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const o = e as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === 'cause') continue;
      const v = o[key];
      try {
        if (typeof v === 'string') o[key] = scrub(v);
        else if (Array.isArray(v)) o[key] = v.map(scrub);
      } catch { /* a read-only field */ }
    }
  }
  return error;
}
