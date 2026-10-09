import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, getAddress, keccak256, verifyTypedData, type Hex } from 'viem';
import type { ChallengeStore, Draft } from './store.js';
import { describeTerms, parseTerms, rulesHash, type SpeciesCatalog } from './terms.js';

/**
 * A creator's challenge before it is funded: the server fixes the terms, deadline and salt,
 * returns the EIP-712 ReceiveWithAuthorization the creator signs, and later relays it to the
 * contract (chainOps.ts). The nonce commits to every term, as WildsentiaChallenges.authorizationNonce does.
 */

export interface DraftConfig {
  chainId: number;
  contract: Hex;
  usdc: Hex;
  /** The USDC token's EIP-712 domain name and version (checked on Arc before use). */
  usdcDomain: { name: string; version: string };
  minPrizeAtomic: bigint;
  maxPrizeAtomic: bigint;
}

/** Deadlines the server offers, in days (the contract's rails are 12 hours to 15 days). */
export const DEADLINE_DAYS = [1, 2, 3, 5, 7, 10, 14] as const;
/** How long a signed authorization may wait to be relayed: the token has no way to cancel one. */
export const AUTHORIZATION_SECONDS = 30 * 60;

const RECEIVE_TYPES = { ReceiveWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] } as const;

/** USDC amounts as decimal text with up to six places, in 6-decimal ERC-20 units. Never a float. */
export function parseUsdc(text: unknown): bigint | null {
  if (typeof text !== 'string' || !/^[0-9]{1,9}(\.[0-9]{1,6})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

export const formatUsdc = (atomic: bigint | string): string => {
  const v = BigInt(atomic), whole = v / 1_000_000n, frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};

/** keccak256(abi.encode(chainid, contract, creator, rulesHash, prize, deadline, salt)), as the contract computes it. */
export function authorizationNonce(config: Pick<DraftConfig, 'chainId' | 'contract'>, creator: Hex, rules: Hex, prize: bigint,
  deadline: bigint, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint96' }, { type: 'uint64' }, { type: 'bytes32' }],
    [BigInt(config.chainId), config.contract, creator, rules, prize, deadline, salt]));
}

/** The typed data the creator signs for a draft; validBefore is fixed by when the draft was made. */
export function draftTypedData(config: DraftConfig, draft: Draft) {
  return {
    domain: { name: config.usdcDomain.name, version: config.usdcDomain.version, chainId: config.chainId, verifyingContract: config.usdc },
    types: RECEIVE_TYPES,
    primaryType: 'ReceiveWithAuthorization' as const,
    message: { from: getAddress(draft.creatorWallet), to: config.contract, value: BigInt(draft.prizeAtomic), validAfter: 0n,
      validBefore: BigInt(Math.floor(draft.createdAt.getTime() / 1000) + AUTHORIZATION_SECONDS), nonce: draft.authNonce },
  };
}

export async function createDraft(store: ChallengeStore, catalog: SpeciesCatalog, config: DraftConfig,
  input: { creatorWallet: unknown; terms: unknown; prizeUsdc: unknown; days: unknown; accountId?: string }, now: number):
  Promise<{ ok: true; draft: Draft; description: string } | { ok: false; error: string }> {
  if (typeof input.creatorWallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(input.creatorWallet)) return { ok: false, error: 'bad_wallet' };
  const parsed = parseTerms(input.terms, catalog);
  if (!parsed.ok) return parsed;
  const prize = parseUsdc(input.prizeUsdc);
  if (prize === null || prize < config.minPrizeAtomic || prize > config.maxPrizeAtomic) return { ok: false, error: 'bad_prize' };
  if (!DEADLINE_DAYS.includes(input.days as 1)) return { ok: false, error: 'bad_days' };
  const creator = getAddress(input.creatorWallet);
  const deadline = BigInt(Math.floor(now / 1000) + (input.days as number) * 86_400);
  const salt = `0x${randomBytes(32).toString('hex')}` as Hex;
  const rules = rulesHash(parsed.terms);
  const draft = await store.insertDraft({ creatorWallet: creator, terms: parsed.terms, rulesHash: rules, prizeAtomic: prize.toString(),
    deadline: new Date(Number(deadline) * 1000), salt, authNonce: authorizationNonce(config, creator, rules, prize, deadline, salt),
    accountId: input.accountId ?? null });
  return { ok: true, draft, description: describeTerms(parsed.terms, catalog) };
}

/**
 * Checks the creator's signature before spending any gas, then queues the relay. A draft is
 * relayed once; a second signature for it is refused.
 */
export async function relayDraft(store: ChallengeStore, config: DraftConfig, draftId: string, signature: unknown, now: number):
  Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const draft = await store.draft(draftId);
  if (!draft) return { ok: false, status: 404, error: 'not_found' };
  if (draft.relayedAt) return { ok: false, status: 409, error: 'already_created' };
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, status: 400, error: 'bad_signature' };
  const typed = draftTypedData(config, draft);
  if (Number(typed.message.validBefore) * 1000 <= now + 60_000) return { ok: false, status: 409, error: 'draft_expired' };
  let valid = false;
  try { valid = await verifyTypedData({ address: getAddress(draft.creatorWallet), ...typed, signature: signature as Hex }); }
  catch { valid = false; }
  if (!valid) return { ok: false, status: 401, error: 'signature_does_not_match' };
  const queued = await store.enqueueOp('relay_create', { draftId: draft.id }, {
    creator: getAddress(draft.creatorWallet), rulesHash: draft.rulesHash, prize: draft.prizeAtomic,
    deadline: String(Math.floor(draft.deadline.getTime() / 1000)), salt: draft.salt, validAfter: '0',
    validBefore: String(typed.message.validBefore), signature });
  return queued ? { ok: true } : { ok: false, status: 409, error: 'already_queued' };
}
