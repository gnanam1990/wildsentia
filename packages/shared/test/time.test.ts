import { describe, expect, it } from 'vitest';
import { WORLD_SECONDS_PER_DAY, dayOfYear, formatWorldTime, hourOfDay, seasonAt } from '../src/time.js';

describe('world time', () => {
  it('reports hour of day', () => {
    expect(hourOfDay(0)).toBe(0);
    expect(hourOfDay(6 * 3600)).toBe(6);
    expect(hourOfDay(WORLD_SECONDS_PER_DAY + 6 * 3600)).toBe(6);
  });

  it('reports day of year starting at 1', () => {
    expect(dayOfYear(0)).toBe(1);
    expect(dayOfYear(WORLD_SECONDS_PER_DAY)).toBe(2);
  });

  it('cycles seasons across the year', () => {
    const seen = new Set<string>();
    for (let d = 0; d < 360; d++) seen.add(seasonAt(d * WORLD_SECONDS_PER_DAY));
    expect(seen).toEqual(new Set(['monsoon', 'transition', 'dry', 'wet']));
  });

  it('formats as year-season-day hour:minute', () => {
    expect(formatWorldTime(WORLD_SECONDS_PER_DAY * 17 + 6 * 3600 + 42 * 60)).toBe('Y01-monsoon-D18 06:42');
  });
});
