import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHistoryDialog, HistoryPager, historyRetentionNotice, historyUrl, isHistoryPage, type HistoryPage } from '../src/history.js';
afterEach(() => vi.unstubAllGlobals());
const page = (id: string, cursor: string | null = null): HistoryPage => ({ asOfWorldTime: 3600,
  nextEventSequence: 10, pageCursor: `page-${id}`, nextCursor: cursor, retention: 'Retained records',
  events: [{ id, type: 'born', outcome: 'success', worldTime: 0 }] });
describe('bounded retained-history browser', () => {
  it('labels empty checkpoint history honestly without inventing a biography', () => {
    expect(historyRetentionNotice(null)).toContain('Significant events are retained');
    expect(historyRetentionNotice(page('one'))).toBe('Retained records');
    expect(historyRetentionNotice({ ...page('one'), events: [] }, 'No retained person events; no past was reconstructed.'))
      .toBe('Retained records No retained person events; no past was reconstructed.');
  });
  it('keeps one page and returns to the pinned first-page cursor, not a fresh moving checkpoint', async () => {
    const first = page('one', 'older'), second = page('two');
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(second))
      .mockResolvedValueOnce(Response.json(first)); vi.stubGlobal('fetch', fetcher);
    const pager = new HistoryPager(); await pager.open('deer/a');
    expect(pager.pageNumber).toBe(1); expect(pager.hasPrevious).toBe(false);
    await pager.next(); expect(pager.pageNumber).toBe(2); expect(pager.page).toEqual(second);
    await pager.previous(); expect(pager.page).toEqual(first);
    expect(fetcher.mock.calls.map(c => c[0])).toEqual([historyUrl('deer/a'), historyUrl('deer/a', 'older'), historyUrl('deer/a', 'page-one')]);
  });
  it('keeps the loaded page on failures and never accepts a different checkpoint', async () => {
    const first = page('one', 'older');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(first))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ...page('two'), asOfWorldTime: 7200 })));
    const pager = new HistoryPager(); await pager.open('deer');
    await pager.next(); expect(pager.page).toEqual(first); expect(pager.error).toContain('unavailable');
    await pager.next(); expect(pager.page).toEqual(first); expect(pager.error).toContain('checkpoint');
    expect(pager.pageNumber).toBe(1); expect(pager.loading).toBe(false);
  });
  it('aborts closed/replaced history and rejects late results or duplicate navigation', async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>(r => { resolve = r; });
    const fetcher = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(Response.json(page('new')));
    vi.stubGlobal('fetch', fetcher);
    const pager = new HistoryPager(), loading = pager.open('old');
    await pager.next(); expect(fetcher).toHaveBeenCalledTimes(1);
    await pager.open('new'); expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    resolve(Response.json(page('old'))); await loading;
    expect(pager.page!.events[0]!.id).toBe('new');
    pager.close(); expect(pager.loading).toBe(false);
  });
  it('validates clocks, page budgets and continuation metadata before displaying content', () => {
    expect(isHistoryPage(page('one'))).toBe(true);
    for (const bad of [null, {}, { ...page('a'), nextCursor: '' }, { ...page('a'), pageCursor: null },
      { ...page('a'), asOfWorldTime: Infinity }, { ...page('a'), events: Array(26).fill(page('a').events[0]) },
      { ...page('a'), events: [{ ...page('a').events[0], worldTime: 3601 }] }]) expect(isHistoryPage(bad)).toBe(false);
  });
  it('renders a saved tree-route action from the summary flag and dispatches its distinct replay kind', async () => {
    class NodeFixture {
      children: NodeFixture[] = []; textContent = ''; className = ''; id = ''; type = ''; disabled = false;
      open = false; dataset: Record<string, string> = {}; onclick: (() => void) | null = null;
      constructor(readonly tag: string) {}
      append(...children: NodeFixture[]): void { this.children.push(...children); }
      replaceChildren(...children: NodeFixture[]): void { this.children = children; }
      setAttribute(): void {} focus(): void {}
      addEventListener(): void {} showModal(): void { this.open = true; }
      close(): void { this.open = false; }
    }
    const body = new NodeFixture('body');
    vi.stubGlobal('document', { body, createElement: (tag: string) => new NodeFixture(tag), querySelectorAll: () => [],
      querySelector: () => null });
    const saved = { ...page('tree_1'), events: [{ id: 'tree_1', type: 'tree_climbed', outcome: 'success', worldTime: 20,
      hasClimb: true }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(saved)));
    const replay = vi.fn(); createHistoryDialog(replay)('langur_1');
    await vi.waitFor(() => expect(body.children[0]!.children.find(node => node.tag === 'ol')?.children).toHaveLength(1));
    const dialog = body.children[0]!, item = dialog.children.find(node => node.tag === 'ol')!.children[0]!;
    expect(item.children.map(child => child.textContent)).toEqual(['Replay this recorded tree route']);
    item.children[0]!.onclick!();
    expect(replay).toHaveBeenCalledWith('langur_1', 'tree_1', 'climb');
    expect(dialog.open).toBe(false);
    expect(isHistoryPage({ ...saved, events: [{ ...saved.events[0], type: 'moved' }] })).toBe(false);
  });
});
