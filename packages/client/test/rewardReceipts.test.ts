import { describe, expect, it } from 'vitest';
import { describeClaimStatus, forgetClaim, loadClaims, rememberClaim } from '../src/rewardReceipts.js';
import { claimRecovery } from '../src/rewardClaimRecovery.js';

function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}
const claim = (n: number) => ({ claimId: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`, receipt: n.toString(16).padStart(64, 'a'),
  amount: '2.500000', network: 'base', animalId: 'chital_0000', claimedAt: '2026-09-25T00:00:00.000Z' });

describe('claim receipts kept in this browser', () => {
  it('remembers newest first, without duplicates, and at most twenty', () => {
    const store = memory();
    for (let i = 1; i <= 25; i++) rememberClaim(store, claim(i));
    rememberClaim(store, claim(25));
    const claims = loadClaims(store);
    expect(claims).toHaveLength(20);
    expect(claims[0]!.claimId).toBe(claim(25).claimId);
    expect(new Set(claims.map((c) => c.claimId)).size).toBe(20);
    expect(forgetClaim(store, claim(25).claimId)[0]!.claimId).toBe(claim(24).claimId);
  });
  it('survives missing, blocked or tampered storage', () => {
    expect(loadClaims(null)).toEqual([]);
    expect(loadClaims({ getItem: () => 'not json' })).toEqual([]);
    expect(loadClaims({ getItem: () => JSON.stringify([{ claimId: 'x' }, claim(1)]) })).toEqual([claim(1)]);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(rememberClaim(throwing, claim(1))).toEqual([claim(1)]);
  });
  it('never writes a wallet address, even if one is passed in', () => {
    const store = memory();
    rememberClaim(store, { ...claim(3), wallet: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' } as ReturnType<typeof claim>);
    expect(store.getItem('vana.reward-claims')).not.toMatch(/0x5aAeb/i);
  });
  it('explains each status plainly', () => {
    expect(describeClaimStatus('reserved')).toMatch(/not a payment/);
    expect(describeClaimStatus('verified_paid')).toMatch(/verified/);
    expect(describeClaimStatus('something_new')).toBe('Status: something_new');
  });
  it('treats "keep watching" as safe even after an uncertain attempt', () => {
    expect(claimRecovery(425, false)).toBe('keep_watching');
    expect(claimRecovery(425, true)).toBe('keep_watching');
  });
});
