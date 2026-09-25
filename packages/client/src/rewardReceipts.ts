/**
 * The claims this browser made, with the receipts that let it ask the server for their status.
 * Kept in local storage as a convenience only: the ledger is on the server, and a claimant who
 * clears their browser can still quote the claim ID and receipt they were shown.
 */
export interface StoredClaim { claimId: string; receipt: string; amount: string; network: string; animalId: string; claimedAt: string }

const KEY = 'vana.reward-claims';

/** This browser's store, or null where storage is blocked. Wallet addresses never go in it. */
export const browserClaimStore = (() => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } })();
const MAX = 20;
const valid = (c: unknown): c is StoredClaim => {
  const v = c as StoredClaim;
  return !!v && typeof v === 'object' && /^[0-9a-f-]{36}$/i.test(v.claimId) && /^[0-9a-f]{64}$/.test(v.receipt)
    && typeof v.amount === 'string' && typeof v.network === 'string' && typeof v.animalId === 'string' && typeof v.claimedAt === 'string';
};

export function loadClaims(storage: Pick<Storage, 'getItem'> | null): StoredClaim[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, MAX) : [];
  } catch { return []; }
}

export function rememberClaim(storage: Pick<Storage, 'getItem' | 'setItem'> | null, claim: StoredClaim): StoredClaim[] {
  // Only these fields are ever written, whatever the caller passes: never a wallet address.
  const { claimId, receipt, amount, network, animalId, claimedAt } = claim;
  const claims = [{ claimId, receipt, amount, network, animalId, claimedAt },
    ...loadClaims(storage).filter((c) => c.claimId !== claim.claimId)].slice(0, MAX);
  try { storage?.setItem(KEY, JSON.stringify(claims)); } catch { /* the receipt is still shown on screen */ }
  return claims;
}

export function forgetClaim(storage: Pick<Storage, 'getItem' | 'setItem'> | null, claimId: string): StoredClaim[] {
  const claims = loadClaims(storage).filter((c) => c.claimId !== claimId);
  try { storage?.setItem(KEY, JSON.stringify(claims)); } catch { /* nothing else to do */ }
  return claims;
}

/** What a claimant is told about their claim's state. */
export function describeClaimStatus(status: string): string {
  return ({
    reserved: 'Reserved for you. The administrator sends USDC manually; this is not a payment.',
    paid_reported: 'Payment reported by the administrator. Check the transaction below.',
    verified_paid: 'Paid: an exact USDC transfer to your wallet was verified on Base.',
    rejected: 'Rejected by the administrator. The reward was reopened.',
  } as Record<string, string>)[status] ?? `Status: ${status}`;
}
