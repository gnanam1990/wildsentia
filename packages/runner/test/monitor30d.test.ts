import { describe, expect, it } from 'vitest';
import { DURATION_MS, INTERVAL_MS, MAX_GAP_MS, WORLD_HOURS_PER_REAL_HOUR, evaluate, validateUrl } from '../../../tools/ops/monitor-30d.mjs';

const start = { kind: 'start', at: 1_000_000, url: 'https://forest.example.com/api/health',
  durationMs: DURATION_MS, intervalMs: INTERVAL_MS, maxGapMs: MAX_GAP_MS,
  worldHoursPerRealHour: WORLD_HOURS_PER_REAL_HOUR };
const sample = (at: number, worldTime: number, ok = true) => ({ kind: 'sample', at, worldTime, ok });

describe('30-real-day external monitor', () => {
  it('accepts only the public HTTPS health endpoint', () => {
    expect(validateUrl(start.url)).toBe(start.url);
    for (const url of ['http://forest.example.com/api/health',
      'https://forest.example.com/world', 'https://user:pass@forest.example.com/api/health',
      'https://forest.example.com/api/health?key=secret']) expect(() => validateUrl(url)).toThrow();
  });

  it('records healthy sampled progress without claiming unobserved uptime', () => {
    const state = evaluate([start, sample(start.at + INTERVAL_MS, 3600),
      sample(start.at + 2 * INTERVAL_MS, 10800)]);
    expect(state.incidents).toEqual([]);
    expect(state.samples).toBe(2);
    expect(state.complete).toBe(false);
  });

  it('rejects a continuously running but half-speed world', () => {
    const records = [start, ...Array.from({ length: 6 }, (_, i) =>
      sample(start.at + (i + 1) * INTERVAL_MS, (i + 1) * 3600))];
    expect(evaluate(records).incidents.map(item => item.issue)).toContain('world_time_behind_schedule');
  });

  it('rejects monitoring gaps, a failed endpoint, time rollback and stalled simulation', () => {
    const records = [start, sample(start.at + 1, 0),
      sample(start.at + INTERVAL_MS + 1, 3600, false),
      sample(start.at + 3 * INTERVAL_MS + 1, 3600),
      sample(start.at + 4 * INTERVAL_MS + 1, 3500),
      sample(start.at + 5 * INTERVAL_MS + 1, 3500),
      sample(start.at + 6 * INTERVAL_MS + 1, 3500)];
    const issues = evaluate(records).incidents.map(item => item.issue);
    expect(issues).toContain('unhealthy_or_unreachable');
    expect(issues).toContain('observation_gap');
    expect(issues).toContain('world_time_rollback');
    expect(issues).toContain('world_time_stalled');
  });

  it('treats a restarted observer with a gap as failed and refuses journal schema drift', () => {
    expect(evaluate([start, sample(start.at + MAX_GAP_MS + 1, 3600)]).incidents)
      .toContainEqual({ at: start.at + MAX_GAP_MS + 1, issue: 'observation_gap' });
    expect(evaluate([{ ...start, worldHoursPerRealHour: undefined }, sample(start.at + INTERVAL_MS, 3600)]).samples).toBe(1);
    expect(() => evaluate([{ ...start, durationMs: DAY_FOR_TEST }])).toThrow();
    expect(() => evaluate([{ ...start, worldHoursPerRealHour: 6 }])).toThrow();
  });
});

const DAY_FOR_TEST = 86_400_000;
