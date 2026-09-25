import { afterEach, describe, expect, it, vi } from 'vitest';
import { HumanMotionPager, historicHumanFrame, humanMotionUrl, isHumanMotionPage, recordedHumanGaps, recordedHumanPose, type HumanMotionPage } from '../src/humanHistoryReplay.js';
afterEach(() => vi.unstubAllGlobals());
const sample = (seconds: number, x: number, phase: 'travel' | 'work' | null = 'travel') => ({ seconds,
  position: { x, z: 100, heading: 0 }, alive: true, action: phase ? 'gather_food' as const : null,
  phase, taskEventId: phase ? 'task-1' : null });
const page = (id = 'person_0001'): HumanMotionPage => ({ source: 'checkpoint', personId: id,
  asOfWorldTime: 10800, nextEventSequence: 14, pageCursor: 'first', nextCursor: 'older', retention: 'Recorded only.',
  windows: [{ startWorldTime: 7200, endWorldTime: 10800, samples: [sample(0, 100), sample(3600, 101)] },
    { startWorldTime: 0, endWorldTime: 3600, samples: [sample(0, 100), sample(3600, 100.5)] }],
});
describe('recorded human history playback', () => {
  it('accepts only scoped, bounded, monotonic executed samples', () => {
    const good = page(); expect(isHumanMotionPage(good, good.personId)).toBe(true);
    for (const bad of [{ ...good, personId: 'other' }, { ...good, source: 'live' },
      { ...good, windows: [{ ...good.windows[0]!, endWorldTime: 11000 }] },
      { ...good, windows: [good.windows[1], good.windows[0]] },
      { ...good, windows: [{ ...good.windows[0]!, samples: [sample(0, 100), sample(3600, 10000)] }] },
      { ...good, windows: [{ ...good.windows[0]!, samples: [sample(1, 100), sample(3600, 101)] }] }])
      expect(isHumanMotionPage(bad, good.personId)).toBe(false);
  });
  it('never bridges missing hours, extrapolates beyond a page or draws false continuity', () => {
    const windows = page().windows;
    expect(recordedHumanGaps(windows)).toEqual([{ from: 3600, to: 7200 }]);
    expect(recordedHumanPose(windows, 3601)).toBeNull();
    expect(recordedHumanPose(windows, 10801)).toBeNull();
    expect(recordedHumanPose(windows, 0)?.position.x).toBe(100);
    expect(recordedHumanPose(windows, 1800)?.position.x).toBeCloseTo(100.25);
    expect(historicHumanFrame(page(), 1800)).toMatchObject({ source: 'recorded', personId: 'person_0001',
      worldTime: 1800, secondsInWindow: 1800, sample: { position: { x: 100.25 } } });
    expect(historicHumanFrame(page(), 5400)).toMatchObject({ source: 'gap', personId: 'person_0001',
      worldTime: 5400, secondsInWindow: null, sample: null });
    expect(humanMotionUrl('a/b', 'x y')).toContain('a%2Fb/motion?limit=24&cursor=x%20y');
  });
  it('pins backward pages and discards a replaced person response', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(r => { resolve = r; }))
      .mockResolvedValueOnce(Response.json(page('person_0002')));
    vi.stubGlobal('fetch', fetcher);
    const pager = new HumanMotionPager();
    const pending = pager.open('person_0001'); await pager.open('person_0002');
    resolve(Response.json(page())); await pending;
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(pager.page?.personId).toBe('person_0002');
    pager.close();
  });
  it('keeps the current page when a later recording page changes checkpoint or fails', async () => {
    const first = page(), older = { ...page(), windows: [page().windows[1]!], pageCursor: 'older', nextCursor: null };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(older))
      .mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json({ ...older, asOfWorldTime: 20000 }));
    vi.stubGlobal('fetch', fetcher);
    const pager = new HumanMotionPager();
    await pager.open('person_0001'); await pager.next(); await pager.previous();
    expect(pager.page).toEqual(first);
    expect(fetcher.mock.calls.slice(0, 3).map(c => c[0])).toEqual([
      humanMotionUrl('person_0001'), humanMotionUrl('person_0001', 'older'), humanMotionUrl('person_0001', 'first')]);
    await pager.next(); expect(pager.page).toEqual(first); expect(pager.error).toContain('checkpoint');
  });
});
