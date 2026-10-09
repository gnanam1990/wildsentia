/** A signed-in person, as GET /api/accounts/me gives it (docs/2026-10-09-challenges-design.md §14). */
export interface AccountView {
  handle: string; name: string; xAccountDays: number; agentId: string; playerName: string; wallet: string | null;
  canCreate: boolean; canPlay: boolean; createsLeftToday: number; needs: string[];
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** What the account box says, and which controls it shows. */
export function accountState(a: AccountView | null): { kind: 'signed_out' | 'needs_wallet' | 'too_new' | 'ready'; text: string } {
  if (!a) return { kind: 'signed_out', text: 'Sign in with X to play or create challenges.' };
  if (a.needs.includes('x_account_30_days'))
    return { kind: 'too_new', text: `Signed in as @${a.handle}. Your X account is ${a.xAccountDays} days old: challenges open to it at 30 days. You can still play the forest.` };
  if (!a.wallet) return { kind: 'needs_wallet', text: `Signed in as @${a.handle}. Link a wallet to be paid if you win, and to create challenges.` };
  const left = a.createsLeftToday;
  return { kind: 'ready', text: `Signed in as @${a.handle}, paid to ${shortAddress(a.wallet)}. ${left} challenge${left === 1 ? '' : 's'} left to create today.` };
}

/** A wallet link message is signed only if it is for this site and the wallet that will sign it. */
export function checkSiweMessage(message: string, host: string, address: string): boolean {
  const [first, second] = message.split('\n');
  return first === `${host} wants you to sign in with your Ethereum account:` && second?.toLowerCase() === address.toLowerCase();
}

export const accountErrors: Record<string, string> = {
  signed_out: 'You are signed out. Sign in with X again.',
  wallet_taken: 'That wallet is already linked to another player.',
  wallet_signature_invalid: 'The signature did not match the wallet. Nothing was linked.',
  challenge_expired: 'That request expired. Try linking again.',
  wallet_link_unavailable: 'Wallet linking is not available on this server.',
  wrong_chain: 'Your wallet is on another network. Switch it to the challenge network and try again.',
  wrong_site: 'The message to sign was not for this site, so nothing was signed.',
  no_wallet: 'No browser wallet was found. Install one to link a wallet.',
};
export const errorText = (code: string, fallback = 'Something went wrong. Nothing was changed; try again.') => accountErrors[code] ?? fallback;
