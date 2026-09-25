import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claimRecovery } from '../src/rewardClaimRecovery.js';

describe('observer reward claim recovery', () => {
  it('renews an expired selection only before any uncertain claim result', () => {
    expect(claimRecovery(401, false)).toBe('renew_selection');
    for (const status of [400, 401, 404, 409]) expect(claimRecovery(status, true)).toBe('stop');
  });

  it('keeps uncertainty on the exact original wallet/drop and distinguishes definite rejections', () => {
    expect(claimRecovery(undefined, false)).toBe('retry_exact');
    expect(claimRecovery(503, true)).toBe('retry_exact');
    expect(claimRecovery(400, false)).toBe('correct_input');
    expect(claimRecovery(404, false)).toBe('refresh_reward');
    expect(claimRecovery(409, false)).toBe('refresh_reward');
    expect(claimRecovery(429, true)).toBe('wait');
  });

  it('integrates recovery without persisting wallets, auto-submitting or losing status feedback', () => {
    const source = readFileSync(new URL('../src/rewards.ts', import.meta.url), 'utf8');
    expect(source).toContain('const recovery = claimRecovery(failure.status, earlierUncertain)');
    expect(source).toContain('await this.watch(selectedActor)');
    expect(source).toContain('no claim is being resubmitted');
    expect(source).toContain("submit.textContent = 'Retry exact claim'");
    expect(source).toContain('choice.disabled = true; wallet.readOnly = true');
    expect(source).toContain("status.setAttribute('role', 'status')");
    expect(source).not.toMatch(/(?:localStorage|sessionStorage|indexedDB|document\.cookie)/);
  });
});
