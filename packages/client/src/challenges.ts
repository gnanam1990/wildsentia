import { api, mountAccountBox } from './account.js';
import type { AccountView } from './accountModel.js';
import { acceptErrors, attemptRow, deadlineText, signinMessage, statusLabel, txLink, type AttemptView, type ChallengeView } from './challengesModel.js';

/** The challenges page: open and settled challenges, and one challenge with its attempts (spec §8). */
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
};
let account: AccountView | null = null;
let explorer: string | null = null;
let shown: ChallengeView | null = null;
const showAccept = () => { $('detail-accept').hidden = !(shown?.status === 'open' && account?.canPlay); };

function listCard(c: ChallengeView): HTMLElement {
  const card = el('a', undefined, 'challenge-card');
  card.href = `/challenges.html?id=${c.id}`;
  card.append(el('span', `${c.prizeUsdc} USDC`, 'prize'), el('strong', c.description ?? `Challenge ${c.id}`),
    el('span', `${statusLabel(c.status)} · ${c.status === 'open' ? deadlineText(c.deadline, Date.now()) : `deadline ${new Date(c.deadline).toLocaleString()}`}`, 'meta'));
  return card;
}

async function showList(): Promise<void> {
  const list = $('challenge-list');
  const { challenges } = await api<{ challenges: ChallengeView[] }>('/challenges');
  list.replaceChildren(...(challenges.length ? challenges.map(listCard) : [el('p', 'No challenges yet.')]));
  $('challenge-status').textContent = `${challenges.filter((c) => c.status === 'open').length} open`;
}

async function showDetail(id: string): Promise<void> {
  $('challenge-list-section').hidden = true;
  const detail = $('challenge-detail');
  detail.hidden = false;
  const { challenge: c, attempts } = await api<{ challenge: ChallengeView; attempts: AttemptView[] }>(`/challenges/${encodeURIComponent(id)}`);
  $('detail-title').textContent = c.description ?? `Challenge ${c.id}`;
  $('detail-prize').textContent = `${c.prizeUsdc} USDC`;
  $('detail-state').textContent = `${statusLabel(c.status)} · ${deadlineText(c.deadline, Date.now())}`;
  const briefing = c.goal?.briefing ?? '';
  $('detail-briefing-card').hidden = briefing === '';
  $('detail-briefing').textContent = briefing;
  const links = $('detail-links');
  links.replaceChildren();
  for (const [label, hash] of [['Created on Arc', c.createdTx], ['Settled on Arc', c.settledTx]] as const) {
    const href = txLink(explorer, hash);
    if (!href) continue;
    const a = el('a', label); a.href = href; a.rel = 'noopener noreferrer'; a.target = '_blank';
    links.append(a);
  }
  const rows = $('detail-attempts');
  rows.replaceChildren(...attempts.map((a) => {
    const r = attemptRow(a), tr = el('tr');
    const record = el('a', 'record'); record.href = `/api/challenges/${c.id}/attempts/${encodeURIComponent(a.id)}`;
    const recordCell = el('td'); recordCell.append(record);
    tr.append(el('td', r.player), el('td', r.outcome), el('td', r.detail), recordCell);
    return tr;
  }));
  $('detail-no-attempts').hidden = attempts.length > 0;
  shown = c;
  showAccept();
  const accept = $<HTMLButtonElement>('detail-accept');
  accept.onclick = async () => {
    accept.disabled = true;
    const say = $('detail-feedback');
    try {
      const r = await api<{ queued: boolean; position?: number }>(`/play/challenges/${c.id}/accept`, { method: 'POST' });
      if (!r.queued) { location.href = '/play.html'; return; }
      say.textContent = `No animal is free yet: you are number ${r.position} on the waiting list. Your attempt starts on its own when one comes free.`;
      $('detail-play-link').hidden = false;
    } catch (e) { say.textContent = acceptErrors[(e as Error).message] ?? 'Could not accept the challenge. Try again.'; }
    finally { accept.disabled = false; }
  };
}

async function main(): Promise<void> {
  const notice = signinMessage(location.search);
  if (notice) $('page-notice').textContent = notice;
  account = await mountAccountBox((a) => { account = a; $('create-link').hidden = !a?.canCreate; showAccept(); });
  try { explorer = (await api<{ explorerUrl: string | null }>('/challenges/info')).explorerUrl; } catch { explorer = null; }
  const id = new URLSearchParams(location.search).get('id');
  const detail = !!id && /^[0-9]{1,15}$/.test(id);
  try { if (detail) await showDetail(id); else await showList(); }
  catch (e) {
    const text = (e as Error).message === 'not_found' ? 'There is no such challenge.' : 'Challenges are not available right now.';
    // Errors go where they can be seen: the detail view hides the list's status line.
    $(detail ? 'detail-feedback' : 'challenge-status').textContent = text;
    if (detail) $('detail-attempts-card').hidden = true;
  }
}

void main();
