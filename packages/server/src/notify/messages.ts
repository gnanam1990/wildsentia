import { formatWorldTime } from '@vana/shared';
import type { ArcBounty } from '../arcBounties/store.js';

/**
 * The alert texts for Congo bounties paid on Arc (docs/2026-10-19-congo-arc-bounties-design.md,
 * "Alerts"): short, plain lines that read on a phone. A live bounty's alert says only what the
 * public board says (publicArcBounty): its amount, species, region and deadline, never the animal
 * or its agent, since a hunter told the target would simply go and kill it.
 */

export interface AlertContext {
  /** The public site (an origin, no trailing slash), or null: the texts then carry no site links. */
  origin: string | null;
  /** World hours per real hour (host.worldHoursPerRealHour, 12 by default). */
  rate: () => number;
  /** The world time being played, for how long a live bounty has left when its alert goes out. */
  now: () => number;
  /** A transaction's explorer link, if an explorer is configured (ArcBountyEngine.txUrl). */
  txUrl: (hash: string | null) => string | null;
}

/** USDC's 6-decimal units as a plain amount: 5000000 is "5", 1500000 is "1.5". */
export function usdcText(atomic: bigint): string {
  const sign = atomic < 0n ? '-' : '', a = atomic < 0n ? -atomic : atomic;
  const frac = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${a / 1_000_000n}${frac ? `.${frac}` : ''}`;
}

/** A wallet shortened as wallets are shown: 0x1234…abcd. */
export function shortWallet(wallet: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(wallet) ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

/** About how long a span of real hours is, in the unit a person would say it in. */
export function aboutRealTime(hours: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (!Number.isFinite(hours) || hours <= 0) return 'any moment now';
  if (hours < 1) return `about ${plural(Math.max(1, Math.round(hours * 60)), 'minute')}`;
  if (hours < 48) return `about ${plural(Math.round(hours * 2) / 2, 'hour')}`;
  return `about ${plural(Math.round(hours / 24 * 10) / 10, 'day')}`;
}

const species = (id: string) => id.replace(/_/g, ' ');

/** A bounty gone live: what the public board shows, and a link to it. */
export function publishedAlert(b: ArcBounty, ctx: AlertContext): string {
  const leftWorldSeconds = Math.max(0, b.deadlineWorldTime - ctx.now());
  const realHours = leftWorldSeconds / 3600 / Math.max(1e-9, ctx.rate());
  return [
    `New bounty: ${usdcText(b.amountAtomic)} USDC on a ${species(b.targetSpeciesId)} in region ${b.targetRegion}.`,
    // Whether an agent steers the target is not said: few steered animals of a species would narrow it down.
    'Paid to the agent whose predator kills it before the deadline, or, if it lives, to the agent keeping it alive (if any).',
    `Deadline: ${formatWorldTime(b.deadlineWorldTime, 'congo_v1')} world time, ${aboutRealTime(realHours)} from now.`,
    ...(ctx.origin ? [`Board: ${ctx.origin}/bounties.html#${b.bountyId}`] : []),
  ].join('\n');
}

/** A bounty paid or returned: the outcome, the target now revealed, who won, and the transaction. */
export function settledAlert(b: ArcBounty, ctx: AlertContext): string | null {
  if (!b.outcome) return null;
  const amount = `${usdcText(b.amountAtomic)} USDC`, tx = ctx.txUrl(b.decideTx);
  const paid = b.payeeWallet ? [`Paid to ${shortWallet(b.payeeWallet)}.`] : [];
  const lines = b.outcome === 'predator' ? [
    `Bounty won by a hunter: ${amount}.`,
    `${b.winnerAnimalId ?? 'A predator'} killed the target, ${b.targetAnimalId}.`, ...paid,
    ...(tx ? [`Payment: ${tx}`] : []),
  ] : b.outcome === 'survived' ? [
    `Bounty won by the prey: ${amount}.`,
    `The target, ${b.targetAnimalId}, survived to the deadline.`, ...paid,
    ...(tx ? [`Payment: ${tx}`] : []),
  ] : [
    `Bounty closed with no winner: ${amount} back to the pool.`,
    `The target was ${b.targetAnimalId}.${b.killAnimalId ? ` ${b.killAnimalId} killed it, but the kill did not qualify.` : ''}`,
    ...(tx ? [`Return: ${tx}`] : []),
  ];
  const watch = b.winnerAnimalId ?? b.targetAnimalId;
  if (ctx.origin) lines.push(`Watch: ${ctx.origin}/#animal=${encodeURIComponent(watch)}`);
  return lines.join('\n');
}

/** The alert for an event the bounty engine announced, or null if there is nothing to say. */
export function arcBountyAlert(event: { kind: 'published' | 'settled'; bounty: ArcBounty }, ctx: AlertContext): string | null {
  return event.kind === 'published' ? publishedAlert(event.bounty, ctx) : settledAlert(event.bounty, ctx);
}
