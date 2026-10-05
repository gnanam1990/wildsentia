import { describe, expect, it } from 'vitest';
import { rewardTotalsLine, visitorAmount } from '../src/rewardTotals.js';

describe('public reward totals', () => {
  it('shows unclaimed, claimed and paid, adding reported and verified payments exactly', () => {
    expect(rewardTotalsLine({ available: '4.500006', reserved: '3.000009', paidReported: '5.250000', verifiedPaid: '0.000001', network: 'base' }))
      .toBe('4.500006 USDC unclaimed · 3.000009 claimed · 5.250001 paid · base');
  });
  it('drops trailing zeros and treats missing or malformed amounts as zero', () => {
    expect(rewardTotalsLine({ available: '10.000000', reserved: '0.000000', network: 'base' }))
      .toBe('10 USDC unclaimed · 0 claimed · 0 paid · base');
    expect(rewardTotalsLine({ available: '1e3', reserved: '2.5', paidReported: '0.100000', network: 'base' }))
      .toBe('0 USDC unclaimed · 0 claimed · 0.1 paid · base');
  });
});

describe('visitor amounts', () => {
  it('drops trailing zeros but keeps every significant micro-unit', () => {
    expect(visitorAmount('1.000000')).toBe('1');
    expect(visitorAmount('0.250000')).toBe('0.25');
    expect(visitorAmount('12.000001')).toBe('12.000001');
    expect(visitorAmount('not-an-amount')).toBe('not-an-amount');
  });
});
