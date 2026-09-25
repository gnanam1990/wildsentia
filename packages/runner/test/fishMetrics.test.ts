import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { emptyFishEventMetrics, recordFishEvent, validFishEventMetrics } from '../src/fishMetrics.js';

const event = (type: WorldEvent['type']): WorldEvent => ({
  id: `test_${type}`, type, worldTime: 1, simVersion: 'test', patchId: 0, actors: [],
  conditions: {}, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative',
});

describe('fish cohort milestone accounting', () => {
  it('counts only recorded lifecycle events, including a dried cohort', () => {
    const metrics = emptyFishEventMetrics();
    for (const type of ['fed', 'fish_spawned', 'fish_hatched', 'fish_recruited',
      'fish_spawned', 'fish_cohort_lost'] as const) recordFishEvent(metrics, event(type));
    expect(metrics).toEqual({ spawned: 2, hatched: 1, recruited: 1, cohortLost: 1 });
    expect(validFishEventMetrics(metrics)).toBe(true);
  });

  it('rejects impossible event totals', () => {
    expect(validFishEventMetrics({ spawned: 1, hatched: 2, recruited: 0, cohortLost: 0 })).toBe(false);
    expect(validFishEventMetrics({ spawned: 1, hatched: 0, recruited: 1, cohortLost: 0 })).toBe(false);
    expect(validFishEventMetrics({ spawned: 1, hatched: 1, recruited: 1, cohortLost: 1 })).toBe(false);
    expect(validFishEventMetrics({ spawned: -1, hatched: 0, recruited: 0, cohortLost: 0 })).toBe(false);
  });
});
