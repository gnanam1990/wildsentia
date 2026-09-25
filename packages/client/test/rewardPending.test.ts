import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pendingAllocationMatch, shouldLockRewardAdmin } from '../src/rewardPending.js';

describe('uncertain reward allocation reconciliation', () => {
  it('reconciles only exact ID, animal, amount, network and reveal terms on any page', () => {
    const pending = { id: 'allocation-104', actorId: 'tiger-7', amount: '5', revealWhen: 'carcass' };
    const matching = { id: pending.id, actorId: pending.actorId, amount: '5.000000', network: 'base', revealWhen: pending.revealWhen };
    const drops = Array.from({ length: 105 }, (_, i) => ({ ...matching, id: `allocation-${i}` }));
    expect(pendingAllocationMatch(pending, drops.slice(0, 100))).toBe('absent');
    expect(pendingAllocationMatch(pending, drops.slice(100))).toBe('exact');
    expect(pendingAllocationMatch(null, drops)).toBe('absent');
    for (const changed of [
      { actorId: 'tiger-8' }, { amount: '5.000001' }, { network: 'ethereum' }, { revealWhen: 'watch' },
    ]) expect(pendingAllocationMatch(pending, [{ ...matching, ...changed }])).toBe('conflict');
    expect(pendingAllocationMatch({ ...pending, amount: 'invalid' }, [matching])).toBe('conflict');
  });

  it('uses the same exact-ID proof for first and older pages without persisting admin secrets', () => {
    const source = readFileSync(new URL('../src/rewardsAdmin.ts', import.meta.url), 'utf8');
    expect(source.match(/pendingAllocationMatch\(/g)).toHaveLength(2);
    expect(source).toContain('Earlier allocation found on an older page');
    expect(source).toContain('The earlier allocation ID exists with different terms');
    expect(source).toContain('clearPending(); dropId = crypto.randomUUID();');
    expect(source).toContain('const requestToken = token');
    expect(source).toContain('shouldLockRewardAdmin(response.status, requestToken, token)');
    expect(source).not.toMatch(/sessionStorage\.setItem\([^\n]*token/);
  });

  it('does not lock a newer session for a stale unauthorized response', () => {
    expect(shouldLockRewardAdmin(401, 'old-token', 'new-token')).toBe(false);
    expect(shouldLockRewardAdmin(401, 'old-token', '')).toBe(false);
    expect(shouldLockRewardAdmin(401, '', '')).toBe(false);
    expect(shouldLockRewardAdmin(403, 'new-token', 'new-token')).toBe(false);
    expect(shouldLockRewardAdmin(401, 'new-token', 'new-token')).toBe(true);
  });

  it('keeps verified settlement separate from unverified manual reporting in the admin UI', () => {
    const source = readFileSync(new URL('../src/rewardsAdmin.ts', import.meta.url), 'utf8');
    expect(source).toContain('receiptVerificationAvailable = ledger.receiptVerificationAvailable === true');
    expect(source).toContain("api('/admin/rewards/settle-verified', { dropId: claim.drop_id, claimId: claim.id,");
    expect(source).toContain("api('/admin/rewards/review', { dropId: drop, claimId: claim?.id, action,");
    expect(source).toContain('It does not send USDC');
    expect(source).toContain('do not send another transfer');
    expect(source).toContain('payment reported (unverified)');
    expect(source).toContain('Allocation is not a proven treasury balance');
    expect(source).not.toMatch(/sendTransaction|wallet_send|eth_sendTransaction/);
  });
});
