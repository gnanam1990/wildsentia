import { usdc } from './arcAdminModel.js';
import { ToldBounties, bountyNews, isLive, isResult, liveSummary, realTimeLeft, resultLines, wantedLine, type BountyNews, type PublicBounty } from './bountyBoardModel.js';

/**
 * The Arc bounties in the forest itself (docs/2026-10-19-congo-arc-bounties-design.md): a chip in
 * the bar while any is live, a card that pops up when one goes live or is decided, and a panel with
 * every live bounty and the latest results. A live bounty shows its amount, species and region,
 * never which animal; the viewer can fly to its region or watch a decided one's record.
 */
export interface BountyForestHooks {
  /** Fly the camera over a region's middle, `sizeM` across. */
  flyTo(x: number, z: number, sizeM: number): void;
  /** Replay a decided bounty's record in the forest. */
  watch(bountyId: string): void;
}

const POLL_MS = 20_000;
const POP_MS = 25_000;
const readable = (id: string) => id.replaceAll('_', ' ');
const button = (text: string, onClick: () => void, className = 'text-button') => {
  const b = document.createElement('button'); b.type = 'button'; b.className = className; b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
};
const link = (href: string, text: string, external = true) => {
  const a = document.createElement('a'); a.href = href; a.textContent = text; a.className = 'bounty-link';
  if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
};

export class BountyForest {
  readonly #chip = document.createElement('button');
  readonly #pops = document.createElement('div');
  readonly #dialog = document.createElement('dialog');
  readonly #live = document.createElement('ol');
  readonly #results = document.createElement('ol');
  readonly #pool = document.createElement('p');
  readonly #told: ToldBounties;
  #list: PublicBounty[] = [];
  #poolAtomic: string | null = null;
  #rate = 12;
  #timer = 0;
  #firstLook: boolean;

  constructor(private readonly hooks: BountyForestHooks, chipHost: HTMLElement, storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.#told = new ToldBounties(storage);
    this.#firstLook = this.#told.first;
    this.#chip.type = 'button'; this.#chip.id = 'bounty-chip'; this.#chip.className = 'chip bounty-chip'; this.#chip.hidden = true;
    this.#chip.setAttribute('aria-haspopup', 'dialog'); this.#chip.title = 'Live USDC bounties on prey in this forest';
    this.#chip.addEventListener('click', () => this.open());
    chipHost.append(this.#chip);

    this.#pops.className = 'bounty-pops'; this.#pops.setAttribute('role', 'status'); this.#pops.setAttribute('aria-live', 'polite');
    document.body.append(this.#pops);

    this.#dialog.className = 'forest-dialog bounty-panel'; this.#dialog.setAttribute('aria-labelledby', 'bounty-panel-title');
    const header = document.createElement('div'); header.className = 'dialog-header';
    const title = document.createElement('h2'); title.id = 'bounty-panel-title'; title.textContent = 'Bounties';
    header.append(title, button('Close', () => this.#dialog.close()));
    const intro = document.createElement('p'); intro.className = 'bounty-intro';
    intro.textContent = 'A USDC bounty sits on a prey animal nobody is told. An AI agent whose predator catches it before the deadline is paid on Arc Testnet; '
      + 'if an agent steers that prey and keeps it alive, that agent is paid.';
    this.#pool.className = 'bounty-pool';
    const liveHead = document.createElement('h3'); liveHead.textContent = 'Live now';
    const resultHead = document.createElement('h3'); resultHead.textContent = 'Latest results';
    this.#live.className = 'bounty-list'; this.#results.className = 'bounty-list';
    const footer = document.createElement('div'); footer.className = 'bounty-footer';
    footer.append(link('/bounties.html', 'Full board, pool and top agents', false), link('/connect.html#quick-start', 'Play as an AI agent', false));
    this.#dialog.append(header, intro, this.#pool, liveHead, this.#live, resultHead, this.#results, footer);
    document.body.append(this.#dialog);
  }

  /** Starts reading the board; a server without Arc bounties leaves the forest as it was. */
  start(): void {
    void this.refresh();
    this.#timer = window.setInterval(() => { if (!document.hidden) void this.refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.refresh(); });
  }

  stop(): void { clearInterval(this.#timer); }

  async refresh(): Promise<void> {
    let list: PublicBounty[];
    try {
      const [board, stats] = await Promise.all([
        fetch('/api/congo/arc-bounties', { cache: 'no-store' }).then((r) => (r.ok ? r.json() as Promise<{ poolAtomic: string | null; bounties: PublicBounty[] }> : null)),
        fetch('/api/congo/arc-bounties/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() as Promise<{ worldHoursPerRealHour?: number }> : null)).catch(() => null),
      ]);
      if (!board) return;
      list = board.bounties; this.#poolAtomic = board.poolAtomic; this.#rate = stats?.worldHoursPerRealHour || this.#rate;
    } catch { return; }
    this.#list = list;
    const summary = liveSummary(list);
    this.#chip.hidden = !summary;
    const [count, total] = (summary ?? '').split(' · ');
    const sum = document.createElement('span'); sum.className = 'bounty-chip-sum'; sum.textContent = total ? ` · ${total}` : '';
    this.#chip.replaceChildren(count ?? '', sum);
    let news = bountyNews(list, this.#told.set);
    // A first visit hears what is live now, not every old result.
    if (this.#firstLook) {
      this.#firstLook = false;
      this.#told.add(...news.filter((n) => n.kind === 'result').map((n) => n.key));
      news = news.filter((n) => n.kind === 'live');
    }
    for (const n of news.slice(0, 3)) this.#pop(n);
    this.#told.add(...news.map((n) => n.key));
    if (this.#dialog.open) this.#render();
  }

  open(): void {
    this.#render();
    if (!this.#dialog.open) this.#dialog.showModal();
  }

  #actions(b: PublicBounty, after: () => void = () => undefined): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (isLive(b)) {
      if (b.area) out.push(button('Fly to its region', () => { this.#dialog.close(); after(); this.hooks.flyTo(b.area!.x, b.area!.z, b.area!.sizeM); }));
      if (b.publishTxUrl) out.push(link(b.publishTxUrl, 'Reserved on Arc'));
    } else {
      out.push(button('Watch it', () => { this.#dialog.close(); after(); this.hooks.watch(b.bountyId); }));
      if (b.decideTxUrl) out.push(link(b.decideTxUrl, b.outcome === 'void' ? 'Returned on Arc' : 'Paid on Arc'));
    }
    return out;
  }

  #lines(b: PublicBounty): { headline: string; detail: string } {
    if (isLive(b)) {
      const left = realTimeLeft(b.timeLeftWorldSeconds, this.#rate);
      return { headline: `Wanted: ${wantedLine(b)}`, detail: `Somewhere in region ${b.region}, ${left} left. Which ${readable(b.speciesId)}? Hunters are never told.` };
    }
    return resultLines(b);
  }

  #pop(n: BountyNews): void {
    const card = document.createElement('article'); card.className = `bounty-pop bounty-pop-${n.kind === 'live' ? 'live' : n.bounty.outcome}`;
    const kicker = document.createElement('small');
    kicker.textContent = n.kind === 'live' ? 'New bounty on Arc' : n.bounty.outcome === 'void' ? 'Bounty ended' : 'Bounty paid on Arc';
    const { headline, detail } = this.#lines(n.bounty);
    const h = document.createElement('strong'); h.textContent = headline;
    const p = document.createElement('p'); p.textContent = detail;
    const remove = () => { card.remove(); };
    const actions = document.createElement('div'); actions.className = 'bounty-pop-actions';
    actions.append(...this.#actions(n.bounty, remove), button('Details', () => { remove(); this.open(); }));
    const close = button('×', remove, 'bounty-pop-close'); close.setAttribute('aria-label', 'Dismiss');
    card.append(close, kicker, h, p, actions);
    this.#pops.prepend(card);
    while (this.#pops.childElementCount > 3) this.#pops.lastElementChild!.remove();
    window.setTimeout(remove, POP_MS);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Wildsentia', { body: `${headline}. ${detail}`, tag: n.key }); } catch { /* not allowed here */ }
    }
  }

  #render(): void {
    this.#pool.textContent = this.#poolAtomic === null ? '' : `In the pool for the next bounties: ${usdc(this.#poolAtomic)}.`;
    const card = (b: PublicBounty) => {
      const li = document.createElement('li'); li.className = `bounty-card${isLive(b) ? ' bounty-card-live' : ` bounty-card-${b.outcome}`}`;
      const { headline, detail } = this.#lines(b);
      const h = document.createElement('strong'); h.textContent = headline;
      const p = document.createElement('p'); p.textContent = detail;
      const actions = document.createElement('div'); actions.className = 'bounty-pop-actions'; actions.append(...this.#actions(b));
      li.append(h, p, actions);
      return li;
    };
    const empty = (text: string) => { const li = document.createElement('li'); li.className = 'bounty-empty'; li.textContent = text; return li; };
    const live = this.#list.filter(isLive), done = this.#list.filter(isResult).slice(0, 8);
    this.#live.replaceChildren(...(live.length ? live.map(card) : [empty('No live bounty right now. The next one could drop any time.')]));
    this.#results.replaceChildren(...(done.length ? done.map(card) : [empty('No results yet.')]));
  }
}
