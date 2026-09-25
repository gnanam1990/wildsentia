import { validNextCursor } from './historyCursor.js';
export { validNextCursor } from './historyCursor.js';

export interface HistoryEvent { id: string; type: string; worldTime: number; outcome: string;
  encounter?: unknown; hasEncounter?: boolean; hasClimb?: boolean }
export interface HistoryPage {
  asOfWorldTime: number; nextEventSequence: number; events: HistoryEvent[];
  nextCursor: string | null; pageCursor: string; retention: string;
}
export const historyUrl = (id: string, cursor?: string | null): string =>
  `/api/animals/${encodeURIComponent(id)}/events?limit=25&view=summary${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
export function historyRetentionNotice(page: HistoryPage | null, emptyText = 'No retained events at this saved checkpoint.'): string {
  if (!page) return 'Significant events are retained; old routine actions may have been pruned.';
  return `${page.retention}${page.events.length === 0 ? ` ${emptyText}` : ''}`;
}
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function isHistoryPage(value: unknown): value is HistoryPage {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as HistoryPage;
  return whole(p.asOfWorldTime) && whole(p.nextEventSequence) && validNextCursor(p.nextCursor)
    && typeof p.pageCursor === 'string' && validNextCursor(p.pageCursor)
    && typeof p.retention === 'string' && Array.isArray(p.events) && p.events.length <= 25
    && p.events.every(e => e && typeof e.id === 'string' && typeof e.type === 'string'
      && (e.hasEncounter === undefined || typeof e.hasEncounter === 'boolean')
      && (e.hasClimb === undefined || typeof e.hasClimb === 'boolean' && (!e.hasClimb || e.type === 'tree_climbed'))
      && typeof e.outcome === 'string' && whole(e.worldTime) && e.worldTime <= p.asOfWorldTime);
}

export interface HistorySource {
  url: (id: string, cursor?: string | null) => string;
  validate: (value: unknown, id: string) => value is HistoryPage;
}
const animalHistorySource: HistorySource = { url: historyUrl, validate: isHistoryPage };

/** One page in memory. Failed requests leave the current page and navigation position intact. */
export class HistoryPager {
  id = '';
  page: HistoryPage | null = null;
  pageNumber = 0;
  loading = false;
  error = '';
  #cursors: Array<string | null> = [];
  #revision = 0;
  #abort: AbortController | null = null;
  constructor(private readonly change: () => void = () => {}, private readonly source: HistorySource = animalHistorySource) {}
  get hasPrevious(): boolean { return this.pageNumber > 1; }
  close(): void { this.#revision++; this.#abort?.abort(); this.loading = false; }
  async open(id: string): Promise<void> {
    this.close(); this.id = id; this.page = null; this.pageNumber = 0; this.#cursors = [];
    await this.#load(null, 1);
  }
  async next(): Promise<void> {
    if (!this.loading && this.page?.nextCursor) await this.#load(this.page.nextCursor, this.pageNumber + 1);
  }
  async previous(): Promise<void> {
    if (!this.loading && this.hasPrevious) await this.#load(this.#cursors[this.pageNumber - 2]!, this.pageNumber - 1);
  }
  async #load(cursor: string | null, pageNumber: number): Promise<void> {
    const revision = ++this.#revision, id = this.id;
    this.#abort?.abort(); this.#abort = new AbortController();
    this.loading = true; this.error = ''; this.change();
    try {
      const response = await fetch(this.source.url(id, cursor), { signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error(response.status === 400 ? 'History cursor expired. Start again to read the recovered history.' : 'History unavailable. Retry the page or start again.');
      const page: unknown = await response.json();
      if (revision !== this.#revision) return;
      if (!this.source.validate(page, id)) throw new Error('History response invalid. Start again.');
      if (cursor && this.page && (page.asOfWorldTime !== this.page.asOfWorldTime || page.nextEventSequence !== this.page.nextEventSequence))
        throw new Error('History checkpoint changed. Start again.');
      this.page = page; this.pageNumber = pageNumber;
      this.#cursors[pageNumber - 1] = page.pageCursor;
    } catch (error) {
      if (revision === this.#revision) this.error = error instanceof Error ? error.message : 'History unavailable. Try again.';
    } finally { if (revision === this.#revision) { this.loading = false; this.change(); } }
  }
}

/** Native modal: bounded list, text-only event content, Escape/close, stable controls and status. */
export function createHistoryDialog(replay?: (id: string, eventId: string, kind: 'encounter' | 'climb') => void, options: {
  titleId?: string; title?: string; source?: HistorySource; eventText?: (event: HistoryEvent) => string;
  emptyText?: string; onClose?: () => void;
} = {}): (id: string) => void {
  const dialog = document.createElement('dialog'); dialog.className = 'forest-dialog history-dialog';
  dialog.setAttribute('aria-labelledby', options.titleId ?? 'history-title');
  const title = document.createElement('h2'); title.id = options.titleId ?? 'history-title';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
  const note = document.createElement('p'), list = document.createElement('ol');
  list.setAttribute('aria-label', 'Retained events, newest first');
  const controls = document.createElement('div'); controls.className = 'history-controls';
  const button = (text: string, action: () => void) => {
    const b = document.createElement('button'); b.textContent = text; b.type = 'button'; b.onclick = action; controls.append(b); return b;
  };
  let pageRendered: HistoryPage | null = null;
  const pager = new HistoryPager(() => {
    title.textContent = `${options.title ?? 'Retained history'} · ${pager.id}`;
    list.setAttribute('aria-busy', String(pager.loading));
    status.textContent = pager.loading ? `Loading history page…` : pager.error ||
      `Page ${pager.pageNumber} · newest first · saved world second ${pager.page?.asOfWorldTime ?? 0}${pager.page?.nextCursor ? '' : ' · end of retained history'}`;
    previous.disabled = pager.loading || !pager.hasPrevious;
    next.disabled = pager.loading || !pager.page?.nextCursor;
    restart.disabled = pager.loading;
    note.textContent = historyRetentionNotice(pager.page, options.emptyText);
    if (pager.page !== pageRendered) {
      pageRendered = pager.page;
      list.start = Math.max(1, (pager.pageNumber - 1) * 25 + 1);
      list.replaceChildren(...(pager.page?.events ?? []).map(e => {
        const item = document.createElement('li');
        item.textContent = options.eventText ? options.eventText(e) : `World second ${e.worldTime} · ${e.type} · ${e.outcome} · ${e.id}`;
        if ((e.hasEncounter ?? !!e.encounter) && replay) {
          const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Replay this recorded encounter';
          open.onclick = () => { const id = pager.id; dialog.close(); replay(id, e.id, 'encounter'); }; item.append(open);
        }
        if (e.type === 'tree_climbed' && e.hasClimb && replay) {
          const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Replay this recorded tree route';
          open.onclick = () => { const id = pager.id; dialog.close(); replay(id, e.id, 'climb'); }; item.append(open);
        }
        return item;
      }));
    }
  }, options.source);
  const previous = button('Newer page', () => { void pager.previous(); });
  const next = button('Older page', () => { void pager.next(); });
  const restart = button('Start again', () => { void pager.open(pager.id); });
  const close = button('Close history', () => dialog.close());
  dialog.addEventListener('close', () => {
    pager.close();
    if (options.onClose) { options.onClose(); return; }
    // The live passport may have refreshed and replaced the original modal opener.
    const opener = [...document.querySelectorAll<HTMLButtonElement>('[data-history]')].find(b => b.dataset.history === pager.id);
    (opener ?? document.querySelector<HTMLElement>('#view'))?.focus();
  });
  dialog.append(title, status, controls, note, list); document.body.append(dialog);
  return id => { if (!dialog.open) dialog.showModal(); close.focus(); void pager.open(id); };
}
