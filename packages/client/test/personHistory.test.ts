import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryPager } from '../src/history.js';
import { isPersonHistoryPage, personHistorySource, personHistoryUrl, type PersonHistoryPage } from '../src/personHistory.js';
afterEach(() => vi.unstubAllGlobals());
const page = (id = 'person_0001', eventId = 'event_1'): PersonHistoryPage => ({
  source: 'checkpoint', personId: id, asOfWorldTime: 100, nextEventSequence: 20,
  nextCursor: 'older', pageCursor: 'first', retention: 'Retained records, not animation replay.',
  events: [{ id: eventId, worldTime: 90, type: 'human_task_finished', outcome: 'failure', actors: [id, 'village_0001'],
    conditions: { action: 'fish', reason: 'no_catch' }, effects: {} }],
});
describe('person-specific retained history', () => {
  it('rejects wrong actors, sources, clocks and malformed facts before formatting them', () => {
    const p = page(); expect(isPersonHistoryPage(p, p.personId)).toBe(true);
    for (const bad of [{ ...p, source: 'live' }, { ...p, personId: 'person_0002' },
      { ...p, events: [{ ...p.events[0], actors: ['person_0002'] }] },
      { ...p, events: [{ ...p.events[0], effects: { rawFishKg: 'invented' } }] },
      { ...p, events: [p.events[0], p.events[0]] },
      { ...p, events: [{ ...p.events[0], worldTime: 101 }] }]) expect(isPersonHistoryPage(bad, p.personId)).toBe(false);
  });
  it('uses person routes with stable pinned backward navigation and refuses checkpoint/identity changes', async () => {
    const first = page(), older = { ...page('person_0001', 'event_0'), pageCursor: 'older', nextCursor: null };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(older))
      .mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json({ ...older, asOfWorldTime: 200 }))
      .mockResolvedValueOnce(Response.json(page('person_0002')));
    vi.stubGlobal('fetch', fetcher); const pager = new HistoryPager(undefined, personHistorySource);
    await pager.open('person_0001'); await pager.next(); await pager.previous();
    expect(fetcher.mock.calls.slice(0, 3).map(c => c[0])).toEqual([
      personHistoryUrl('person_0001'), personHistoryUrl('person_0001', 'older'), personHistoryUrl('person_0001', 'first')]);
    await pager.next(); expect(pager.page).toEqual(first); expect(pager.error).toContain('checkpoint');
    await pager.next(); expect(pager.page).toEqual(first); expect(pager.error).toContain('invalid');
    expect(personHistoryUrl('a/b', 'x y')).toContain('a%2Fb/events?limit=25&cursor=x%20y');
  });
  it('cancels a replaced person and never publishes a late previous-person response', async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(r => { resolve = r; }))
      .mockResolvedValueOnce(Response.json(page('person_0002')));
    vi.stubGlobal('fetch', fetcher); const pager = new HistoryPager(undefined, personHistorySource);
    const pending = pager.open('person_0001'); await pager.open('person_0002');
    resolve(Response.json(page('person_0001'))); await pending;
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    expect((pager.page as PersonHistoryPage).personId).toBe('person_0002');
    pager.close(); expect(pager.loading).toBe(false);
  });
});
