import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { signingString } from '../src/live/signing.js';

// Signed agent requests for tests: an Ed25519 key and the headers the live API checks.
export function keypair(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x! };
}
export function signedHeaders(k: { privateKey: KeyObject; publicKey: string }, audience: string, method: string, path: string, body = ''): Record<string, string> {
  const timestamp = String(Date.now()), nonce = randomBytes(18).toString('base64url');
  const signature = sign(null, Buffer.from(signingString({ audience, method, path, timestamp, nonce, body })), k.privateKey).toString('base64url');
  return { 'x-vana-key': k.publicKey, 'x-vana-timestamp': timestamp, 'x-vana-nonce': nonce, 'x-vana-signature': signature,
    ...(body ? { 'content-type': 'application/json' } : {}) };
}
