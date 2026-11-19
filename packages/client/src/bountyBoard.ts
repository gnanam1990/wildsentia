import './pageChrome.js';
import { short, usdc } from './arcAdminModel.js';
import { realTimeLeft, resultLines, shareUrl, wantedLine, xIntent, type PublicBounty } from './bountyBoardModel.js';

/**
 * The public bounty board (docs/2026-10-19-congo-arc-bounties-design.md): live bounties (never which
 * animal), results with their payments on Arc and a replay to watch, the pool's flows, and the
 * agents that won the most this week and all time.
 */
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
interface Stats {
  contract: string; contractUrl: string | null; worldHoursPerRealHour: number; poolAtomic: string | null; reservedAtomic: string | null;
  fundedAtomic: string | null; paidAtomic: string; returnedAtomic: string;
}
interface Leaders { season: { id: string; start: string; end: string } | null; agents: Array<{ agentId: string; name: string | null; kills: number; escapes: number; wonAtomic: string }> }

let rate = 12, season: 'current' | 'all' = 'current';
const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`/api${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json() as Promise<T>;
};
const link = (href: string | null | undefined, text: string, external = true): HTMLElement => {
  if (!href) { const s = document.createElement('span'); s.textContent = text; return s; }
  const a = document.createElement('a'); a.href = href; a.textContent = text;
  if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
};
const empty = (text: string) => { const li = document.createElement('li'); li.className = 'small board-empty'; li.textContent = text; return li; };

async function share(b: PublicBounty, button: HTMLButtonElement): Promise<void> {
  const url = shareUrl(location.origin, b.bountyId), text = b.outcome ? resultLines(b).headline : `Wanted: ${wantedLine(b)}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Wildsentia', text, url }); return; }
    await navigator.clipboard.writeText(url);
    button.textContent = 'Link copied';
    setTimeout(() => { button.textContent = 'Share'; }, 2000);
  } catch { /* the viewer closed the share sheet */ }
}
/** Posting a bounty to X: the server's share page carries its card, so the post shows it. */
const postOnX = (b: PublicBounty): HTMLElement => {
  const text = b.outcome ? resultLines(b).headline : `Wanted: ${wantedLine(b)} in the Wildsentia forest`;
  const a = link(xIntent(text, shareUrl(location.origin, b.bountyId)), 'Post on X');
  a.classList.add('post-x');
  return a;
};
const shareButton = (b: PublicBounty) => {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet'; button.textContent = 'Share';
  button.addEventListener('click', () => { void share(b, button); });
  return button;
};

function card(b: PublicBounty): HTMLLIElement {
  const li = document.createElement('li'); li.className = 'board-card'; li.id = b.bountyId;
  if (location.hash.slice(1) === b.bountyId) li.classList.add('board-highlight');
  const h = document.createElement('h3'), p = document.createElement('p'), actions = document.createElement('div');
  p.className = 'small'; actions.className = 'board-actions';
  if (!b.outcome) {
    h.textContent = wantedLine(b);
    const left = realTimeLeft(b.timeLeftWorldSeconds, rate);
    p.textContent = `Somewhere in region ${b.region}. ${left.charAt(0).toUpperCase()}${left.slice(1)} left. Which animal is it? Hunters find out the hard way.`;
    actions.append(link(b.publishTxUrl, 'Reserved on Arc'), link('/connect.html#quick-start', 'Join the hunt', false), postOnX(b), shareButton(b));
  } else {
    const lines = resultLines(b);
    h.textContent = lines.headline; p.textContent = lines.detail;
    li.classList.add(`board-${b.outcome}`);
    actions.append(link(b.watchPath, 'Watch it', false), link(b.decideTxUrl, b.outcome === 'void' ? 'Returned on Arc' : 'Paid on Arc'), postOnX(b), shareButton(b));
  }
  li.append(h, p, actions);
  return li;
}

async function refresh(): Promise<void> {
  try {
    const [stats, list] = await Promise.all([get<Stats>('/congo/arc-bounties/stats'), get<{ bounties: PublicBounty[] }>('/congo/arc-bounties')]);
    rate = stats.worldHoursPerRealHour || 12;
    $('board-pool').textContent = usdc(stats.poolAtomic);
    $('board-reserved').textContent = usdc(stats.reservedAtomic);
    $('board-funded').textContent = usdc(stats.fundedAtomic);
    $('board-paid').textContent = usdc(stats.paidAtomic);
    $('board-returned').textContent = usdc(stats.returnedAtomic);
    $('board-contract').replaceChildren(link(stats.contractUrl, short(stats.contract)));
    const live = list.bounties.filter((b) => !b.outcome && b.status !== 'publishing'), done = list.bounties.filter((b) => b.outcome && b.status !== 'deciding');
    $('board-live').replaceChildren(...(live.length ? live.map(card) : [empty('No live bounty right now. The next one could drop any time.')]));
    $('board-results').replaceChildren(...(done.length ? done.slice(0, 20).map(card) : [empty('No results yet.')]));
    $('board-status').textContent = `Updated ${new Date().toLocaleTimeString()}.`;
    const target = location.hash.slice(1);
    if (target && document.getElementById(target) && !refreshed) { document.getElementById(target)!.scrollIntoView({ block: 'center' }); refreshed = true; }
  } catch { $('board-status').textContent = 'The board is unavailable right now. It will try again.'; }
  await leaders();
}
let refreshed = false;

async function leaders(): Promise<void> {
  try {
    const board = await get<Leaders>(`/congo/arc-bounties/leaderboard?season=${season}`);
    $('board-season').textContent = board.season ? `Season ${board.season.id}: ${new Date(board.season.start).toLocaleDateString()} to ${new Date(new Date(board.season.end).getTime() - 1).toLocaleDateString()}.` : 'Every season.';
    const rows = $('board-leaders');
    if (!board.agents.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 5; td.textContent = 'No winners yet. Be the first.'; tr.append(td); rows.replaceChildren(tr); return; }
    rows.replaceChildren(...board.agents.map((a, i) => {
      const tr = document.createElement('tr');
      for (const text of [String(i + 1), a.name ?? a.agentId, String(a.kills), String(a.escapes), usdc(a.wonAtomic)]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
      return tr;
    }));
  } catch { /* the bounties above still show */ }
}

for (const [id, value] of [['board-tab-week', 'current'], ['board-tab-all', 'all']] as const) {
  $(id).addEventListener('click', () => {
    season = value;
    $('board-tab-week').setAttribute('aria-selected', String(value === 'current'));
    $('board-tab-all').setAttribute('aria-selected', String(value === 'all'));
    void leaders();
  });
}
addEventListener('hashchange', () => { refreshed = false; void refresh(); });
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
