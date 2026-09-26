/** The public reward summary the server returns, amounts as exact six-decimal strings. */
export interface RewardSummary { available: string; reserved: string; paidReported?: string; verifiedPaid?: string; network: string }

const micro = (amount: string | undefined): bigint => {
  const m = /^([0-9]+)\.([0-9]{6})$/.exec(amount ?? '');
  return m ? BigInt(m[1]!) * 1_000_000n + BigInt(m[2]!) : 0n;
};
const display = (value: bigint): string => {
  const whole = value / 1_000_000n, fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
};

/**
 * What visitors see: unclaimed drops waiting in the forest, drops claimed and awaiting the
 * administrator's manual payment, and drops paid (reported or verified on-chain).
 */
export function rewardTotalsLine(summary: RewardSummary): string {
  const paid = micro(summary.paidReported) + micro(summary.verifiedPaid);
  return `${display(micro(summary.available))} USDC unclaimed · ${display(micro(summary.reserved))} claimed · ${display(paid)} paid · ${summary.network}`;
}
