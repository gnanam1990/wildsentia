import { describe, expect, it, vi } from 'vitest';
import { highlightsHtml, InsightPanel, outlookHtml, validHighlights, validOutlook, type OutlookBody } from '../src/insights.js';

const outlook: OutlookBody = { available: true, asOfWorldTime: 3600, model: 'jev-1.13.0', confidence: 0.7,
  notice: 'An estimate by TypeSafe AI (Jev) from saved checkpoint state. The simulation decides what actually happens.',
  choices: [{ goal: 'find_water', label: 'Go to water and drink', probability: 0.62 }, { goal: 'rest', label: 'Rest or sleep', probability: 0.25 },
    { goal: 'flee', label: 'Flee from danger', probability: 0.08 }, { goal: 'wander', label: 'Move on', probability: 0.03 },
    { goal: 'breed', label: 'Look for a mate', probability: 0.02 }] };

describe('observer insights in the browser', () => {
  it('shows the likely next hour as labelled bars, most likely first, with its caveat', () => {
    const html = outlookHtml(outlook);
    expect(html).toContain("What's likely next?");
    expect(html.indexOf('Drink')).toBeLessThan(html.indexOf('Rest'));
    expect(html).toContain('62%'); expect(html).not.toContain('Find a mate'); // Top four only.
    expect(html).toContain('fairly sure'); expect(html).toContain('simulation decides');
    expect(outlookHtml({ available: false, reason: 'not_configured' })).toBe('');
    expect(outlookHtml(null)).toBe('');
  });

  it('escapes whatever the server sends', () => {
    const html = outlookHtml({ ...outlook, model: '<img src=x onerror=alert(1)>', choices: [{ goal: '<b>', label: '"x"', probability: 1 }] });
    expect(html).not.toContain('<img'); expect(html).toContain('&lt;b&gt;'); expect(html).toContain('&lt;img');
  });

  it('lists highlights in plain words and hides them when there are none', () => {
    const body = { available: true as const, asOfWorldTime: 7200, model: 'jev', notice: 'n',
      highlights: [{ event: { id: 'e1', type: 'hunt', outcome: 'success', actors: ['tiger_0001', 'sambar_0002'], worldTime: 7000 }, score: 3.4, confidence: 0.8 }] };
    const html = highlightsHtml(body);
    expect(html).toContain('Highlights'); expect(html).toContain('A tiger caught a sambar'); expect(html).toContain('★ 3.4');
    expect(highlightsHtml({ ...body, highlights: [] })).toBe('');
    // Not before it happens on screen.
    expect(highlightsHtml(body, 6900)).toBe('');
    expect(highlightsHtml(body, 7000)).toContain('A tiger caught a sambar');
    expect(highlightsHtml({ available: false, reason: 'not_configured' })).toBe('');
  });

  it('accepts only well-formed replies', () => {
    expect(validOutlook(outlook)).toBe(true);
    expect(validOutlook({ available: true, choices: 'x' })).toBe(false);
    expect(validHighlights({ available: true, highlights: [{ event: {}, score: 'high' }] })).toBe(false);
    expect(validHighlights({ available: false, reason: 'budget_exhausted' })).toBe(true);
  });

  it('refuses replies whose text or events would break the card when drawn', () => {
    const { model: _m, ...noModel } = outlook;
    expect(validOutlook(noModel)).toBe(false);
    expect(validOutlook({ ...outlook, notice: 42 })).toBe(false);
    expect(validOutlook({ ...outlook, choices: [{ goal: 'rest', label: null, probability: .5 }] })).toBe(false);
    expect(validOutlook({ ...outlook, choices: Array.from({ length: 500 }, () => outlook.choices[0]) })).toBe(false);
    expect(validOutlook({ available: false, reason: 'x' })).toBe(true);
    const highlights = { available: true, asOfWorldTime: 7200, model: 'jev', notice: 'n',
      highlights: [{ event: { id: 'e1', type: 'hunt' }, score: 3, confidence: .8 }] };
    expect(validHighlights(highlights)).toBe(true);
    expect(validHighlights({ ...highlights, highlights: [{ event: null, score: 3, confidence: .8 }] })).toBe(false);
    expect(validHighlights({ ...highlights, highlights: [{ event: [], score: 3, confidence: .8 }] })).toBe(false);
    expect(validHighlights({ ...highlights, model: undefined })).toBe(false);
    expect(validHighlights({ ...highlights, notice: {} })).toBe(false);
    // Every reply the checks accept can be drawn.
    for (const body of [outlook, highlights]) {
      expect(() => (validOutlook(body) ? outlookHtml(body) : '')).not.toThrow();
      expect(() => (validHighlights(body) ? highlightsHtml(body) : '')).not.toThrow();
    }
  });

  it('asks for the followed animal, drops a stale reply and clears on unfollow', async () => {
    const outlookEl = { innerHTML: '' } as HTMLElement, highlightsEl = { innerHTML: '' } as HTMLElement;
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('first')) await slow;
      return new Response(JSON.stringify(outlook), { status: 200 });
    });
    const panel = new InsightPanel(outlookEl, highlightsEl, fetchImpl as typeof fetch);
    const first = panel.outlook('first');
    await panel.outlook('second');
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/insights/animals/second/outlook');
    expect(outlookEl.innerHTML).toContain('Drink');
    outlookEl.innerHTML = 'second';
    release(); await first;
    expect(outlookEl.innerHTML).toBe('second'); // The older request did not overwrite it.
    await panel.outlook(null);
    expect(outlookEl.innerHTML).toBe('');
  });
});
