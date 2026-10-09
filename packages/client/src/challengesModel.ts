/** The challenges page's logic, kept apart from the page so it can be tested (spec §8). */
export interface ChallengeView {
  id: number; status: string; goal: { template: string; speciesId: string; briefing?: string; rules?: unknown[] } | null;
  description: string | null; prizeUsdc: string; deadline: string; creator: string; winnerAttempt: string | null;
  createdTx: string | null; settledTx: string | null;
}
export interface AttemptView { id: string; agentName: string | null; status: string; endReason: string | null; kills: number; escapes: number }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function deadlineText(deadline: string, now: number): string {
  const left = Date.parse(deadline) - now;
  if (!(left > 0)) return 'deadline passed';
  const minutes = Math.floor(left / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days > 0) return `ends in ${plural(days, 'day')}${hours % 24 ? ` ${hours % 24} h` : ''}`;
  if (hours > 0) return `ends in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `ends in ${Math.max(1, minutes)} min`;
}

const STATUS: Record<string, string> = {
  open: 'Open', won: 'Won: the prize is being paid', paid: 'Won and paid',
  unpaid: 'Won, but the payout failed: it goes back to the creator', refunding: 'Going back to the creator', refunded: 'Returned to the creator',
};
export const statusLabel = (s: string) => STATUS[s] ?? s;

/** An explorer link, only for a real transaction hash and a configured explorer. */
export function txLink(explorer: string | null, hash: string | null): string | null {
  if (!explorer || !hash || !/^0x[0-9a-fA-F]{64}$/.test(hash) || !/^https:\/\//.test(explorer)) return null;
  return `${explorer}/tx/${hash}`;
}

const FAILED: Record<string, string> = { caught: 'caught by a predator', died: 'the animal died', released: 'the animal was let go',
  idle: 'left idle', deadline: 'out of time', animal_lost: 'lost its animal', rule_zone: 'it left the zone', rule_no_run: 'it ran',
  rule_herd: 'it left its herd' };
const VOID: Record<string, string> = { birth: 'the animal gave birth', lost_in_restart: 'the server restarted', challenge_won: 'someone else won first',
  challenge_closed: 'the challenge had closed', animal_lost: 'the animal was lost as it started' };

export function attemptRow(a: AttemptView): { player: string; outcome: string; detail: string } {
  const why = (map: Record<string, string>, label: string) => (a.endReason && map[a.endReason] ? `${label}: ${map[a.endReason]}` : label);
  const outcome = a.status === 'running' ? 'Playing now' : a.status === 'met' ? 'Met the goal'
    : a.status === 'void' ? why(VOID, 'Void') : why(FAILED, 'Failed');
  return { player: a.agentName ?? 'a player', outcome, detail: `${plural(a.kills, 'kill')}, ${plural(a.escapes, 'escape')}` };
}

export function signinMessage(search: string): string | null {
  return new URLSearchParams(search).get('signin') === 'failed' ? 'Signing in with X did not finish. Nothing was changed; try again.' : null;
}

export const acceptErrors: Record<string, string> = {
  payout_wallet_required: 'Link a wallet first: the prize is paid to it.',
  x_account_too_new: 'Your X account must be at least 30 days old to play for a prize.',
  creator_cannot_play: 'You created this challenge, so you cannot play it.',
  already_in_a_challenge: 'You are already playing a challenge.',
  already_waiting: 'You are already waiting for another challenge.',
  release_your_animal_first: 'Let your current animal go first (on the play page).',
  no_attempts_left: 'You have used your three attempts at this challenge.',
  deadline_passed: 'This challenge has ended.', not_open: 'This challenge is not open.', signed_out: 'Sign in with X first.',
  challenges_starting: 'Challenges are starting up. Try again in a moment.', animal_lost: 'The animal was lost as the attempt started. Try again.',
  cooldown: 'Wait a little after losing an animal before taking another.', no_free_animal: 'No animal of that species is free right now.',
};
