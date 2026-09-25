import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedEventSummary, Hud, type HudElements } from '../src/hud.js';
import { WorldStore } from '../src/protocol.js';

const elements = (): HudElements => ({
  clock: { innerHTML: '' } as HTMLElement,
  season: { innerHTML: '' } as HTMLElement,
  population: { innerHTML: '' } as HTMLElement,
  passport: { innerHTML: '' } as HTMLElement,
  feed: { innerHTML: '' } as HTMLElement,
  notice: { textContent: '' } as HTMLElement,
});

afterEach(() => vi.unstubAllGlobals());

describe('factual live event feed', () => {
  it('presents a readable outcome without inventing actor, time or event facts', () => {
    expect(feedEventSummary({ id: 'event_1', type: 'human_task_finished', actors: ['human_0001'],
      worldTime: 90_060, outcome: 'success' })).toEqual({
      title: 'Village task finished', meta: 'human_0001 · day 2, 01:01 · success', id: 'event_1',
    });
    expect(feedEventSummary({ type: 'unknown_action' })).toEqual({
      title: 'Unknown action', meta: 'actor not recorded · time not recorded', id: 'not recorded',
    });
    expect(feedEventSummary({ id: 'flower_1', type: 'flower_visitation_settled', patchId: 214,
      actors: [], worldTime: 293 * 86400, outcome: 'failure' })).toEqual({
      title: 'Modelled insect visitation settled',
      meta: 'patch 214 · aggregate guild · day 294, 00:00 · failure', id: 'flower_1',
    });
  });

  it('escapes server text and keeps IDs in an accessible disclosure', async () => {
    const nodes = elements();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ events: [{
      id: '<script>', type: 'human_hunt', actors: ['human_<img>'], worldTime: 3600, outcome: 'failed',
    }] }) })));
    await new Hud(nodes, new WorldStore()).refreshFeed();
    expect(nodes.feed.innerHTML).toContain('Village hunt');
    expect(nodes.feed.innerHTML).toContain('day 1, 01:00 · failed');
    expect(nodes.feed.innerHTML).toContain('<summary>Record ID</summary>');
    expect(nodes.feed.innerHTML).not.toContain('<script>');
    expect(nodes.feed.innerHTML).not.toContain('<img>');
  });

  it('shows an unavailable state for a failed checkpoint read', async () => {
    const nodes = elements();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await new Hud(nodes, new WorldStore()).refreshFeed();
    expect(nodes.feed.innerHTML).toContain('event feed unavailable');
  });
});
