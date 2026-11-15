import { describe, expect, it } from 'vitest';
import { ARC_MAINNET, ARC_TESTNET, payoutPolicy } from '../src/arcBounties/policy.js';

/** Who bounties may pay, and how much, on Arc Testnet and Arc Mainnet (docs/2026-11-15-arc-mainnet-readiness.md). */
describe('the payout policy', () => {
  const approved = { VANA_ARC_BOUNTIES_MAINNET_APPROVED: 'true' };

  it('pays any agent with a proven wallet on testnet, uncapped, unless told otherwise', () => {
    expect(payoutPolicy({}, ARC_TESTNET)).toEqual({ mainnet: false, identity: 'none', ownerDailyCapAtomic: null });
    expect(payoutPolicy({ VANA_ARC_BOUNTIES_IDENTITY: 'x', VANA_ARC_BOUNTIES_OWNER_DAILY_CAP_USDC: '2.5' }, ARC_TESTNET))
      .toEqual({ mainnet: false, identity: 'x', ownerDailyCapAtomic: 2_500_000n });
  });

  it('runs on mainnet only once approved, paying only X accounts 30 days old, 5 USDC an owner a day by default', () => {
    expect(() => payoutPolicy({}, ARC_MAINNET)).toThrow('VANA_ARC_BOUNTIES_MAINNET_APPROVED=true');
    expect(() => payoutPolicy({ VANA_ARC_BOUNTIES_MAINNET_APPROVED: '1' }, ARC_MAINNET)).toThrow('MAINNET_APPROVED');
    expect(payoutPolicy(approved, ARC_MAINNET)).toEqual({ mainnet: true, identity: 'x', ownerDailyCapAtomic: 5_000_000n });
    expect(payoutPolicy({ ...approved, VANA_ARC_BOUNTIES_OWNER_DAILY_CAP_USDC: '20' }, ARC_MAINNET).ownerDailyCapAtomic).toBe(20_000_000n);
  });

  it('accepts no switch on mainnet that loosens a guard', () => {
    for (const [name, value] of [['VANA_ARC_BOUNTIES_IDENTITY', 'none'], ['VANA_ARC_BOUNTIES_OWNER_DAILY_CAP_USDC', '0'],
      ['VANA_ARC_BOUNTIES_DAILY_CAP_USDC', '0'], ['VANA_ARC_BOUNTIES_FUNDING_CHECK', 'off'], ['VANA_ARC_BOUNTIES_SAME_NETWORK_OK', '1']]) {
      expect(() => payoutPolicy({ ...approved, [name!]: value }, ARC_MAINNET), name).toThrow(name!);
    }
  });

  it('refuses any other chain, and a setting it cannot read', () => {
    expect(() => payoutPolicy(approved, 1)).toThrow('must be Arc Testnet (5042002) or Arc Mainnet (5042)');
    expect(() => payoutPolicy({ VANA_ARC_BOUNTIES_IDENTITY: 'erc8004' }, ARC_TESTNET)).toThrow('must be x or none');
    expect(() => payoutPolicy({ VANA_ARC_BOUNTIES_OWNER_DAILY_CAP_USDC: 'lots' }, ARC_TESTNET)).toThrow('must be a USDC amount');
  });
});
