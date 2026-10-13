import { describe, expect, it } from 'vitest';
import { WORLD_SECONDS_PER_DAY, formatWorldTime, isFlooded, seasonAt } from '../src/index.js';

const day = (d: number) => (d - 1) * WORLD_SECONDS_PER_DAY;

describe('the Congo calendar', () => {
  it('has long rains, a drier spell, short rains and another drier spell', () => {
    expect([1, 91, 181, 271].map((d) => seasonAt(day(d), 'congo_v1'))).toEqual(['monsoon', 'transition', 'wet', 'transition']);
    expect(formatWorldTime(day(91), 'congo_v1')).toContain('-transition-');
  });
  it('leaves every other world on the island calendar', () => {
    for (const profile of [undefined, 'mainland', 'island_v1', 'island_v2'] as const)
      expect([1, 91, 181, 271].map((d) => seasonAt(day(d), profile))).toEqual(['monsoon', 'transition', 'dry', 'wet']);
  });
  it('floods the flooded forest in both rainy seasons; rivers are always water', () => {
    expect(isFlooded({ habitat: 'flooded_forest' }, 'monsoon')).toBe(true);
    expect(isFlooded({ habitat: 'flooded_forest' }, 'wet')).toBe(true);
    expect(isFlooded({ habitat: 'flooded_forest' }, 'transition')).toBe(false);
    expect(isFlooded({ habitat: 'water' }, 'transition')).toBe(true);
    expect(isFlooded({ habitat: 'terra_firme' }, 'monsoon')).toBe(false);
  });
});
