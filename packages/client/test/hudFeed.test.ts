import { afterEach, describe, expect, it, vi } from 'vitest';
import { collapseFeed, feedEventSummary, feedSentence, friendlyWorldTime, happenedBy, Hud, type HudElements } from '../src/hud.js';
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
  it('tells visitors what happened in plain words', () => {
    expect(feedSentence({ type: 'scavenged', actors: ['vulture_0721', 'sambar_0339'], outcome: 'success' })).toBe('A vulture fed on a sambar carcass');
    expect(feedSentence({ type: 'hunt', actors: ['dhole_01', 'hare_02'], outcome: 'success' })).toBe('A dhole caught a hare');
    expect(feedSentence({ type: 'died', actors: ['boar_05ec', 'dhole_0703'], outcome: 'success', conditions: { cause: 'predation' } }))
      .toBe('A wild boar was killed by a dhole');
    expect(feedSentence({ type: 'died', actors: ['boar_05ec'], outcome: 'success', conditions: { cause: 'starvation' } })).toBe('A wild boar died');
    expect(feedSentence({ type: 'born', actors: ['chital_0102'], outcome: 'success' })).toBe('A chital was born');
    expect(feedSentence({ type: 'parent_lost', actors: ['sambar_0102'], outcome: 'success' })).toBe('A young sambar lost its mother');
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

  it('holds back events the played hour has not reached yet', () => {
    const events = [{ id: 'later', worldTime: 9000 }, { id: 'now', worldTime: 7300 }, { id: 'undated' }];
    expect(happenedBy(events, 7300).map((e) => e.id)).toEqual(['now', 'undated']);
    expect(happenedBy(events, null).map((e) => e.id)).toEqual(['later', 'now', 'undated']);
  });
});

describe('collapsed feed', () => {
  it('shows neighbouring identical sentences once with a count and keeps other events in view', () => {
    const rested = (id: number) => ({ id: `r${id}`, type: 'rested', actors: ['squirrel_1', 'squirrel_2'] });
    const rows = collapseFeed([rested(1), rested(2), rested(3), { id: 'h', type: 'hunt', actors: ['dhole_01', 'hare_02'], outcome: 'success' }, rested(4)], 6);
    expect(rows.map((r) => [r.sentence, r.count])).toEqual([
      ['Two giant squirrels rested together', 3], ['A dhole caught a hare', 1], ['Two giant squirrels rested together', 1]]);
    expect(rows[0]!.event.id).toBe('r1');
  });
  it('stops at the row limit', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, type: 'born', actors: [i % 2 ? 'hare_1' : 'chital_1'], outcome: 'success' }));
    expect(collapseFeed(events, 6)).toHaveLength(6);
  });
});
