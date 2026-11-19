import { mountThemeButton } from './theme.js';

/**
 * What every page shares: the theme switch in the site header, and the header's places. Forest,
 * Bounties and AI agents are always there; Play and Challenges appear only where this server runs
 * them (sign-in switched on, challenges open), so nobody is sent to a page that says it is off.
 * (Tests import pages without a DOM.)
 */
const toggle = typeof document === 'undefined' ? null : document.querySelector<HTMLButtonElement>('#theme-toggle');
if (toggle) mountThemeButton(toggle);

/** Whether a probe's answer means the feature runs here: a 404 is a server without it. */
export const featureOn = (status: number): boolean => status !== 404 && status < 500;

async function reveal(id: string, path: string): Promise<void> {
  const link = document.querySelector<HTMLElement>(`#${id}[hidden]`);
  if (!link) return;
  try {
    const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    if (featureOn(res.status)) link.hidden = false;
  } catch { /* stays hidden */ }
}

if (typeof document !== 'undefined') {
  void reveal('nav-play', '/api/accounts/me');
  void reveal('nav-challenges', '/api/challenges/info');
}
