import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Signed agent requests (docs/2026-09-26-live-agents-design.md).
 *
 * Every request carries an Ed25519 public key, a timestamp, a nonce and a signature over
 *
 *   VANA1 \n audience \n METHOD \n path+query \n timestamp \n nonce \n sha256(body)
 *
 * The audience names this world (`vana:<worldId>`), so a request signed for one server or
 * world can never be replayed against another. The path is relative to the API root that
 * the agent was given, which is what this server sees after the proxy strips its prefix.
 */

export const SIGNATURE_SKEW_MS = 120_000;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function signingString(p: { audience: string; method: string; path: string; timestamp: string; nonce: string; body: string }): string {
  const bodyHash = createHash('sha256').update(p.body).digest('hex');
  return ['VANA1', p.audience, p.method.toUpperCase(), p.path, p.timestamp, p.nonce, bodyHash].join('\n');
}

export type SignatureFailure = 'missing_signature' | 'bad_key' | 'bad_signature' | 'stale_timestamp' | 'replayed_nonce' | 'too_many_requests';
export type SignedHeaders = { key?: string | undefined; timestamp?: string | undefined; nonce?: string | undefined; signature?: string | undefined };

/** Replay protection: each key's nonces are remembered for the skew window, and bounded. */
export class NonceStore {
  readonly #seen = new Map<string, Map<string, number>>();
  constructor(private readonly perKey = 600, private readonly maxKeys = 20_000) {}

  /** False if this nonce was used, or the key has made too many requests in the window. */
  claim(key: string, nonce: string, now: number): 'ok' | 'replayed_nonce' | 'too_many_requests' {
    let nonces = this.#seen.get(key);
    if (nonces) for (const [n, until] of nonces) if (until < now) nonces.delete(n);
    if (!nonces) {
      if (this.#seen.size >= this.maxKeys) this.prune(now);
      if (this.#seen.size >= this.maxKeys) return 'too_many_requests';
      nonces = new Map(); this.#seen.set(key, nonces);
    }
    if (nonces.has(nonce)) return 'replayed_nonce';
    if (nonces.size >= this.perKey) return 'too_many_requests';
    nonces.set(nonce, now + 2 * SIGNATURE_SKEW_MS);
    return 'ok';
  }

  prune(now: number): void {
    for (const [key, nonces] of this.#seen) {
      for (const [n, until] of nonces) if (until < now) nonces.delete(n);
      if (nonces.size === 0) this.#seen.delete(key);
    }
  }
}

const keys = new Map<string, KeyObject>();
function publicKey(raw: string): KeyObject | null {
  const cached = keys.get(raw);
  if (cached) return cached;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
    if (keys.size > 5000) keys.clear();
    keys.set(raw, key);
    return key;
  } catch { return null; }
}

/** Checks one request. The nonce is only spent once the signature is known to be good. */
export function verifySigned(h: SignedHeaders, p: { audience: string; method: string; path: string; body: string },
  nonces: NonceStore, now = Date.now()): { ok: true; key: string } | { ok: false; error: SignatureFailure } {
  if (!h.key || !h.timestamp || !h.nonce || !h.signature) return { ok: false, error: 'missing_signature' };
  if (!KEY_RE.test(h.key)) return { ok: false, error: 'bad_key' };
  if (!SIG_RE.test(h.signature) || !NONCE_RE.test(h.nonce) || !/^[0-9]{13}$/.test(h.timestamp)) return { ok: false, error: 'bad_signature' };
  if (Math.abs(Number(h.timestamp) - now) > SIGNATURE_SKEW_MS) return { ok: false, error: 'stale_timestamp' };
  const key = publicKey(h.key);
  if (!key) return { ok: false, error: 'bad_key' };
  const data = Buffer.from(signingString({ ...p, timestamp: h.timestamp, nonce: h.nonce }));
  let good = false;
  try { good = verify(null, data, key, Buffer.from(h.signature, 'base64url')); } catch { good = false; }
  if (!good) return { ok: false, error: 'bad_signature' };
  const claimed = nonces.claim(h.key, h.nonce, now);
  return claimed === 'ok' ? { ok: true, key: h.key } : { ok: false, error: claimed };
}
