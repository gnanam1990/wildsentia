import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accountState, checkSiweMessage } from '../src/accountModel.js';
import { attemptRow, deadlineText, signinMessage, statusLabel, txLink } from '../src/challengesModel.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('pages', () => {
  it('are their own Vite pages with the controls the scripts look for', () => {
    const vite = read('vite.config.ts');
    expect(vite).toContain("challenges: 'challenges.html'");
    const html = read('challenges.html');
    expect(html).toContain('src="/src/challenges.ts"');
    for (const id of ['account-box', 'account-status', 'account-signin', 'account-wallet', 'account-signout', 'challenge-list', 'challenge-detail',
      'challenge-status', 'detail-briefing', 'detail-attempts', 'detail-accept'])
      expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/Written by the challenge's creator/);
  });

  it('never write server text as HTML', () => {
    const sources = readdirSync(new URL('../src/', import.meta.url)).filter((f) => /^(account|challenge|play)/i.test(f) && f.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(1);
    for (const f of sources) expect(read(`src/${f}`), f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('account', () => {
  const base = { handle: 'kavya', name: 'Kavya', xAccountDays: 400, agentId: 'ag_1', playerName: 'kavya', wallet: '0x' + 'a'.repeat(40),
    canCreate: true, canPlay: true, createsLeftToday: 3, needs: [] as string[] };
  it('says what a person can do and what they still need', () => {
    expect(accountState(null)).toEqual({ kind: 'signed_out', text: 'Sign in with X to play or create challenges.' });
    expect(accountState({ ...base, wallet: null, canPlay: false, canCreate: false, needs: ['wallet'] }))
      .toEqual({ kind: 'needs_wallet', text: 'Signed in as @kavya. Link a wallet to be paid if you win, and to create challenges.' });
    expect(accountState({ ...base, xAccountDays: 12, canPlay: false, canCreate: false, needs: ['x_account_30_days'] }))
      .toEqual({ kind: 'too_new', text: 'Signed in as @kavya. Your X account is 12 days old: challenges open to it at 30 days. You can still play the forest.' });
    expect(accountState(base)).toEqual({ kind: 'ready', text: 'Signed in as @kavya, paid to 0xaaaa…aaaa. 3 challenges left to create today.' });
  });
  it('signs a wallet link only for this site and this wallet', () => {
    const address = '0x' + 'AbCd'.repeat(10);
    const message = `wildsentia.lol wants you to sign in with your Ethereum account:\n${address}\n\nLink this wallet…`;
    expect(checkSiweMessage(message, 'wildsentia.lol', address)).toBe(true);
    expect(checkSiweMessage(message, 'wildsentia.lol', address.toLowerCase())).toBe(true);
    expect(checkSiweMessage(message, 'evil.example', address)).toBe(false);
    expect(checkSiweMessage(message, 'wildsentia.lol', '0x' + 'b'.repeat(40))).toBe(false);
    expect(checkSiweMessage(`x${message}`, 'wildsentia.lol', address)).toBe(false);
  });
});

describe('challenges page', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  it('counts down to the deadline in plain words', () => {
    expect(deadlineText('2026-10-12T03:00:00Z', now)).toBe('ends in 2 days 3 h');
    expect(deadlineText('2026-10-10T00:45:00Z', now)).toBe('ends in 45 min');
    expect(deadlineText('2026-10-09T00:00:00Z', now)).toBe('deadline passed');
  });
  it('names each status for people', () => {
    expect(['open', 'won', 'paid', 'unpaid', 'refunding', 'refunded'].map(statusLabel)).toEqual(['Open', 'Won: the prize is being paid',
      'Won and paid', 'Won, but the payout failed: it goes back to the creator', 'Going back to the creator', 'Returned to the creator']);
  });
  it('links transactions to the explorer only when there is one, and only real hashes', () => {
    const hash = `0x${'a'.repeat(64)}`;
    expect(txLink('https://explorer.testnet.arc.io', hash)).toBe(`https://explorer.testnet.arc.io/tx/${hash}`);
    expect(txLink(null, hash)).toBeNull();
    expect(txLink('https://explorer.testnet.arc.io', 'javascript:alert(1)')).toBeNull();
  });
  it('describes each attempt and how it ended', () => {
    expect(attemptRow({ id: 'a1', agentName: 'Stripe', status: 'failed', endReason: 'rule_no_run', kills: 0, escapes: 2 }))
      .toEqual({ player: 'Stripe', outcome: 'Failed: it ran', detail: '0 kills, 2 escapes' });
    expect(attemptRow({ id: 'a2', agentName: null, status: 'met', endReason: 'goal_met', kills: 1, escapes: 0 }))
      .toEqual({ player: 'a player', outcome: 'Met the goal', detail: '1 kill, 0 escapes' });
    expect(attemptRow({ id: 'a3', agentName: 'X', status: 'running', endReason: null, kills: 0, escapes: 0 }).outcome).toBe('Playing now');
    expect(attemptRow({ id: 'a4', agentName: 'X', status: 'void', endReason: 'birth', kills: 0, escapes: 0 }).outcome).toBe('Void: the animal gave birth');
    expect(attemptRow({ id: 'a5', agentName: 'X', status: 'failed', endReason: 'something_new', kills: 0, escapes: 0 }).outcome).toBe('Failed');
  });
  it('explains a sign-in that did not finish', () => {
    expect(signinMessage('?signin=failed')).toBe('Signing in with X did not finish. Nothing was changed; try again.');
    expect(signinMessage('?id=3')).toBeNull();
  });
});
