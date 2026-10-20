import { describe, expect, it } from 'vitest';
import { WATCH_LIMIT, Watchlist, newsOf, newsSince, type WatchEvent } from '../src/animalWatch.js';

// News of the animals a viewer watches: catches, escapes, deaths and births, never the everyday.
describe('animal news', () => {
  const ev = (p: Partial<WatchEvent>): WatchEvent => ({ id: 'e', type: 'fed', worldTime: 0, actors: [], outcome: 'success', ...p });

  it('tells a catch, an escape, a death and a birth, and nothing of eating or resting', () => {
    const me = 'blue_duiker_2011';
    expect(newsOf(me, ev({ type: 'hunt', actors: ['african_leopard_8e3f', me], outcome: 'failure' }))).toBe('Blue duiker #2011 escaped an african leopard.');
    expect(newsOf(me, ev({ type: 'hunt', actors: ['crowned_eagle_a006', me], outcome: 'success' }))).toBe('Blue duiker #2011 was caught by a crowned eagle.');
    expect(newsOf('african_leopard_8e3f', ev({ type: 'hunt', actors: ['african_leopard_8e3f', me], outcome: 'success' }))).toBe('African leopard #8e3f caught a blue duiker.');
    expect(newsOf('african_leopard_8e3f', ev({ type: 'hunt', actors: ['african_leopard_8e3f', me], outcome: 'failure' }))).toBeNull();
    expect(newsOf(me, ev({ type: 'died', actors: [me], conditions: { cause: 'predation' } }))).toBe('Blue duiker #2011 died (predation).');
    expect(newsOf(me, ev({ type: 'born', actors: ['blue_duiker_9999', me] }))).toBe('Blue duiker #2011 gave birth.');
    expect(newsOf(me, ev({ type: 'born', actors: [me, 'blue_duiker_0001'] }))).toBeNull();
    for (const type of ['fed', 'rested', 'drank', 'moved', 'fled']) expect(newsOf(me, ev({ type, actors: [me] }))).toBeNull();
  });

  it('gives only news newer than what was told, oldest first', () => {
    const me = 'blue_duiker_2011', events = [
      ev({ id: 'c', type: 'died', worldTime: 300, actors: [me] }),
      ev({ id: 'b', type: 'fed', worldTime: 200, actors: [me] }),
      ev({ id: 'a', type: 'hunt', worldTime: 100, actors: ['african_leopard_8e3f', me], outcome: 'failure' }),
    ];
    expect(newsSince(me, events, 0).map((n) => n.id)).toEqual(['a', 'c']);
    expect(newsSince(me, events, 100).map((n) => n.id)).toEqual(['c']);
  });

  it('keeps the watched animals in the browser, the oldest dropped past the limit, and survives blocked storage', () => {
    const store = new Map<string, string>(), storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    const list = new Watchlist(storage);
    expect(list.toggle('blue_duiker_2011', 500)).toBe(true);
    expect(list.seen('blue_duiker_2011')).toBe(500);
    list.told('blue_duiker_2011', 700);
    expect(new Watchlist(storage).seen('blue_duiker_2011')).toBe(700);
    expect(list.toggle('blue_duiker_2011', 0)).toBe(false);
    for (let i = 0; i < WATCH_LIMIT + 3; i++) list.toggle(`blue_duiker_${i}`, 0);
    expect(list.ids).toHaveLength(WATCH_LIMIT);
    expect(list.has('blue_duiker_0')).toBe(false);
    const blocked = new Watchlist({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(blocked.toggle('x_1', 0)).toBe(true);
  });
});
