import { describe, expect, it } from 'vitest';
import { parseSeason, seasonOf } from '../src/arcBounties/season.js';

// Bounty seasons: a week each, Monday 00:00 UTC, named by ISO week.
describe('bounty seasons', () => {
  it('names each week as ISO does and starts it on Monday at midnight UTC', () => {
    const s = seasonOf(new Date('2026-10-19T08:30:00Z'));
    expect(s.id).toBe('2026-W43');
    expect(s.start.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(s.end.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(seasonOf(new Date('2026-10-25T23:59:59Z')).id).toBe('2026-W43');
    // A year's edge: 1 January 2027 is a Friday, in 2026's week 53.
    expect(seasonOf(new Date('2027-01-01T12:00:00Z')).id).toBe('2026-W53');
    expect(seasonOf(new Date('2027-01-04T00:00:00Z')).id).toBe('2027-W01');
  });

  it('reads a season back from its name, and refuses what is not one', () => {
    expect(parseSeason('2026-W43')?.start.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(parseSeason('2026-W53')?.start.toISOString()).toBe('2026-12-28T00:00:00.000Z');
    for (const bad of ['2026-W00', '2025-W53', '2026-43', 'all', '']) expect(parseSeason(bad)).toBeNull();
  });
});
