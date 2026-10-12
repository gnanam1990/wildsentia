import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedEventSummary, feedSentence, friendlyWorldTime, groupFeedEvents, Hud, type HudElements } from '../src/hud.js';
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
    expect(nodes.feed.innerHTML).toContain('A village hunt came back empty');
    expect(nodes.feed.innerHTML).not.toContain('<script>');
    expect(nodes.feed.innerHTML).not.toContain('<img>');
  });

  it('shows an unavailable state for a failed checkpoint read', async () => {
    const nodes = elements();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await new Hud(nodes, new WorldStore()).refreshFeed();
    expect(nodes.feed.innerHTML).toContain('event feed unavailable');
  });

  it('shows an explicit empty state before the first recorded event', async () => {
    const nodes = elements();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ events: [] }) })));
    await new Hud(nodes, new WorldStore()).refreshFeed();
    expect(nodes.feed.innerHTML).toContain('No recorded events yet');
  });

  it('leaves an unchanged feed DOM intact and preserves expanded records when other content changes', async () => {
    const nodes = elements();
    const key = JSON.stringify(['drink_one']);
    let html = '', writes = 0;
    let detail = { dataset: { feedGroup: key }, open: false };
    Object.defineProperty(nodes.feed, 'innerHTML', {
      get: () => html,
      set: (value: string) => {
        html = value; writes++;
        detail = { dataset: { feedGroup: key }, open: false }; // A DOM replacement makes fresh, closed details.
      },
    });
    nodes.feed.querySelectorAll = ((selector: string) => selector.endsWith('[open]') && !detail.open ? [] : [detail]) as unknown as HTMLElement['querySelectorAll'];
    let events: Array<Record<string, unknown>> = [{ id: 'drink_one', type: 'drank', actors: ['elephant_1'], worldTime: 4500 }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ events }) })));
    const hud = new Hud(nodes, new WorldStore());
    await hud.refreshFeed();
    const originalDetail = detail;
    detail.open = true;
    await hud.refreshFeed();
    expect(writes).toBe(1);
    expect(detail).toBe(originalDetail);
    expect(detail.open).toBe(true);

    // A newer, different entry updates the feed but leaves this event's disclosure expanded.
    events = [{ id: 'rest_one', type: 'rested', actors: ['boar_1'], worldTime: 4600 }, ...events];
    await hud.refreshFeed();
    expect(writes).toBe(2);
    expect(detail).not.toBe(originalDetail);
    expect(detail.open).toBe(true);
    expect(html).toContain('data-feed-group="[&#34;drink_one&#34;]"');
  });

  it('groups matching sentences in the same world hour while preserving newest group order', () => {
    const events = [
      { id: 'latest', type: 'drank', actors: ['elephant_1'], worldTime: 7199 },
      { id: 'between', type: 'rested', actors: ['sambar_1'], worldTime: 7100 },
      { id: 'earlier', type: 'drank', actors: ['elephant_2'], worldTime: 7000 },
      { id: 'previous-hour', type: 'drank', actors: ['elephant_1'], worldTime: 3599 },
    ];
    expect(groupFeedEvents(events).map(group => ({ sentence: group.sentence, ids: group.events.map(event => event.id) }))).toEqual([
      { sentence: 'An elephant drank water', ids: ['latest', 'earlier'] },
      { sentence: 'A sambar rested', ids: ['between'] },
      { sentence: 'An elephant drank water', ids: ['previous-hour'] },
    ]);
  });

  it('never infers a common hour from missing or invalid event times', () => {
    expect(groupFeedEvents([undefined, Number.NaN, -1, Number.POSITIVE_INFINITY].map((worldTime, index) => ({
      id: `event_${index}`, type: 'drank', actors: ['elephant_1'], worldTime,
    }))).map(group => group.events.length)).toEqual([1, 1, 1, 1]);
  });

  it('keeps the existing six-event window when grouping repetitive records', () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      id: `event_${index}`, type: 'drank', actors: ['elephant_1'], worldTime: 7200 - index,
    }));
    const groups = groupFeedEvents(events);
    expect(groups.flatMap(group => group.events.map(event => event.id))).toEqual(events.slice(0, 6).map(event => event.id));
    expect(events).toHaveLength(12);
  });

  it('counts records rather than animals and discloses every grouped original record', async () => {
    const nodes = elements();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ events: [
      { id: 'drink_<first>', type: 'drank', actors: ['elephant_same'], worldTime: 4500, outcome: 'success' },
      { id: 'drink_<second>', type: 'drank', actors: ['elephant_same'], worldTime: 4000, outcome: 'success' },
    ] }) })));
    await new Hud(nodes, new WorldStore()).refreshFeed();
    expect(nodes.feed.innerHTML.match(/class="event feed-entry"/g)).toHaveLength(1);
    expect(nodes.feed.innerHTML).toContain('2 recorded events');
    expect(nodes.feed.innerHTML).not.toContain('2 elephants');
    expect(nodes.feed.innerHTML).toContain('<summary>Record IDs</summary>');
    expect(nodes.feed.innerHTML).toContain('drink_&#60;first&#62;');
    expect(nodes.feed.innerHTML).toContain('drink_&#60;second&#62;');
    expect(nodes.feed.innerHTML).toContain('day 1, 01:15');
    expect(nodes.feed.innerHTML).toContain('day 1, 01:06');
  });

  it('tells visitors what happened in plain words', () => {
    expect(feedSentence({ type: 'scavenged', actors: ['vulture_0721', 'sambar_0339'], outcome: 'success' })).toBe('A vulture fed on a sambar carcass');
    expect(feedSentence({ type: 'hunt', actors: ['dhole_01', 'hare_02'], outcome: 'success' })).toBe('A dhole caught a hare');
    expect(feedSentence({ type: 'hunt', actors: ['tiger_01', 'elephant_02'], outcome: 'failed' })).toBe("A tiger's hunt for an elephant failed");
    expect(feedSentence({ type: 'rested', actors: ['squirrel_1', 'squirrel_2'] })).toBe('Two giant squirrels rested together');
    expect(feedSentence({ type: 'drank', actors: ['elephant_06fc'] })).toBe('An elephant drank water');
    expect(feedSentence({ type: 'birth', actors: ['boar_1'] })).toBe('A wild boar was born');
    // Unknown actors or types keep the factual label.
    expect(feedSentence({ type: 'flowering_started', actors: [] })).toBe('Modelled flowering began');
    expect(feedSentence({ type: 'mystery', actors: ['chital_1'] })).toBe('Mystery');
  });
  it('shows the world clock the way people read time', () => {
    expect(friendlyWorldTime(4 * 86400 + 15 * 3600)).toBe('Year 1 · Day 5 · 3 pm');
    expect(friendlyWorldTime(0)).toBe('Year 1 · Day 1 · 12 am');
    expect(friendlyWorldTime(360 * 86400 + 12 * 3600)).toBe('Year 2 · Day 1 · 12 pm');
    expect(friendlyWorldTime(Number.NaN)).toBe('—');
  });
});
