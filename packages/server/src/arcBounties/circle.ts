import { constants, createHash, publicEncrypt } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import type { ExternalSigner } from './chain.js';

/**
 * The evaluator as a Circle developer-controlled wallet (docs/2026-10-22-circle-evaluator.md): the
 * key never leaves Circle, and the server holds only an API key and the entity secret, both
 * revocable in Circle's Console. Every write carries a fresh entity secret ciphertext (RSA-OAEP,
 * SHA-256, under Circle's public key) and an idempotency key, so a request sent again after a crash
 * returns the first transaction instead of sending a second.
 *   POST /v1/w3s/developer/transactions/contractExecution, GET /v1/w3s/transactions/{id}
 */
export interface CircleConfig {
  apiKey: string;
  /** The entity secret registered in Circle's Console: 32 bytes, as 64 hex characters. */
  entitySecret: string;
  walletId: string;
  /** The wallet's address: the contract's evaluator. */
  walletAddress: string;
  feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Circle's transaction states that end a transaction (CONFIRMED is in a block, COMPLETE past the confirmations). */
const SUCCESS = new Set(['COMPLETE']);
const FAILED = new Set(['FAILED', 'DENIED', 'CANCELLED']);

/** A UUID v4 drawn from the text: the same call and attempt always get the same idempotency key. */
export function idempotencyUuid(text: string): string {
  const b = createHash('sha256').update(text).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class CircleApiError extends Error {
  constructor(readonly status: number, readonly code: unknown, message: string) { super(message); this.name = 'CircleApiError'; }
}

export function circleSigner(config: CircleConfig): ExternalSigner & { ciphertext(): Promise<string> } {
  if (!/^[0-9a-fA-F]{64}$/.test(config.entitySecret)) throw new Error('the Circle entity secret must be 32 bytes as 64 hex characters');
  const base = (config.baseUrl ?? 'https://api.circle.com').replace(/\/$/, ''), get = config.fetch ?? fetch;
  let publicKey: Promise<string> | null = null;

  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const res = await get(`${base}${path}`, { method, headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => ({})) as { data?: T; code?: unknown; message?: string };
    // Never the request: it carries the ciphertext. The API key is in a header, not the message.
    if (!res.ok) throw new CircleApiError(res.status, json.code, `Circle ${method} ${path.split('?')[0]} failed: ${res.status} ${json.message ?? ''}`.trim());
    return json.data as T;
  };
  /** A fresh ciphertext for every write: Circle refuses one used twice. */
  const ciphertext = async (): Promise<string> => {
    publicKey ??= call<{ publicKey: string }>('GET', '/v1/w3s/config/entity/publicKey').then((d) => d.publicKey)
      .catch((error: unknown) => { publicKey = null; throw error; });
    return publicEncrypt({ key: await publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(config.entitySecret, 'hex')).toString('base64');
  };

  return {
    address: getAddress(config.walletAddress),
    ciphertext,
    async send(contract, data, idempotencyKey) {
      const created = await call<{ id: string; state: string }>('POST', '/v1/w3s/developer/transactions/contractExecution', {
        idempotencyKey, walletId: config.walletId, contractAddress: contract, callData: data,
        feeLevel: config.feeLevel ?? 'MEDIUM', entitySecretCiphertext: await ciphertext(), refId: `wildsentia:${idempotencyKey}`,
      });
      if (!created?.id) throw new Error('Circle returned no transaction id');
      return created.id;
    },
    async state(id) {
      const t = (await call<{ transaction: { state: string; txHash?: string; errorReason?: string } }>('GET', `/v1/w3s/transactions/${encodeURIComponent(id)}`)).transaction;
      const txHash = t.txHash && /^0x[0-9a-fA-F]{64}$/.test(t.txHash) ? t.txHash as Hex : null;
      if (FAILED.has(t.state)) console.error(`[arc-bounty] Circle transaction ${id} ${t.state}${t.errorReason ? `: ${t.errorReason}` : ''}`);
      if (t.state === 'STUCK') console.error(`[arc-bounty] Circle transaction ${id} is stuck below the fee floor: accelerate or cancel it in Circle`);
      return { done: SUCCESS.has(t.state) ? 'success' : FAILED.has(t.state) ? 'reverted' : null, txHash };
    },
  };
}
