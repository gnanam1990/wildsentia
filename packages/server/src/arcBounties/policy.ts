/** Arc's chain ids (docs.arc.io, Connect to Arc). */
export const ARC_TESTNET = 5042002, ARC_MAINNET = 5042;

/** Who may be paid, and how much, on the chain bounties run on (docs/2026-11-15-arc-mainnet-readiness.md). */
export interface PayoutPolicy {
  mainnet: boolean;
  /** `x`: only a person whose X account is at least 30 days old, one owner per X account. `none`: any agent with a proven wallet. */
  identity: 'x' | 'none';
  /** The most one owner may win in 24 hours, in 6-decimal USDC units; null: no cap. */
  ownerDailyCapAtomic: bigint | null;
}

const USDC_AMOUNT = /^\d+(\.\d{1,6})?$/;
const atomic = (usdc: string) => BigInt(Math.round(Number(usdc) * 1e6));

/**
 * The payout policy from the environment. Arc Testnet, or Arc Mainnet once its use is approved after
 * the legal review. On mainnet no switch that loosens a guard is accepted: the daily caps, the
 * funding-graph check and the X identity rule stay on, and the one-machine demo setting is refused.
 */
export function payoutPolicy(env: NodeJS.ProcessEnv, chainId: number): PayoutPolicy {
  if (chainId !== ARC_TESTNET && chainId !== ARC_MAINNET) throw new Error(`VANA_ARC_BOUNTIES_CHAIN_ID must be Arc Testnet (${ARC_TESTNET}) or Arc Mainnet (${ARC_MAINNET})`);
  const mainnet = chainId === ARC_MAINNET;
  if (mainnet) {
    if (env.VANA_ARC_BOUNTIES_MAINNET_APPROVED !== 'true') throw new Error('Arc Mainnet bounties need VANA_ARC_BOUNTIES_MAINNET_APPROVED=true, set only after the legal review');
    if (env.VANA_ARC_BOUNTIES_DAILY_CAP_USDC?.trim() === '0') throw new Error('VANA_ARC_BOUNTIES_DAILY_CAP_USDC cannot be off on Arc Mainnet');
    if (env.VANA_ARC_BOUNTIES_FUNDING_CHECK?.trim() === 'off') throw new Error('VANA_ARC_BOUNTIES_FUNDING_CHECK cannot be off on Arc Mainnet');
    if (env.VANA_ARC_BOUNTIES_SAME_NETWORK_OK === '1') throw new Error('VANA_ARC_BOUNTIES_SAME_NETWORK_OK is for Arc Testnet demos only');
  }
  const identity = env.VANA_ARC_BOUNTIES_IDENTITY?.trim() || (mainnet ? 'x' : 'none');
  if (identity !== 'x' && identity !== 'none') throw new Error('VANA_ARC_BOUNTIES_IDENTITY must be x or none');
  if (mainnet && identity !== 'x') throw new Error('VANA_ARC_BOUNTIES_IDENTITY must be x on Arc Mainnet');
  // 5 USDC a day by default on mainnet, none on testnet; "0" is off (testnet only).
  const ownerCap = env.VANA_ARC_BOUNTIES_OWNER_DAILY_CAP_USDC?.trim() || (mainnet ? '5' : '0');
  if (!USDC_AMOUNT.test(ownerCap)) throw new Error('VANA_ARC_BOUNTIES_OWNER_DAILY_CAP_USDC must be a USDC amount');
  if (mainnet && atomic(ownerCap) <= 0n) throw new Error('VANA_ARC_BOUNTIES_OWNER_DAILY_CAP_USDC cannot be off on Arc Mainnet');
  return { mainnet, identity, ownerDailyCapAtomic: atomic(ownerCap) > 0n ? atomic(ownerCap) : null };
}
