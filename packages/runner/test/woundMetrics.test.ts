import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { emptyWoundEventMetrics, recordWoundEvent, validWoundEventMetrics } from '../src/woundMetrics.js';

const event = (type: WorldEvent['type']): WorldEvent => ({
  id: `test_${type}`, type, worldTime: 1, simVersion: 'test', patchId: 0, actors: ['chital_1'],
  conditions: {}, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative',
});

describe('wound event accounting', () => {
  it('counts only recorded milestones and accepts healing with or without infection', () => {
    const m = emptyWoundEventMetrics();
    for (const type of ['hunt', 'wounded', 'wounded', 'wound_infected', 'wound_healed', 'wound_healed'] as const)
      recordWoundEvent(m, event(type));
    expect(m).toEqual({ wounded: 2, infected: 1, healed: 2, fatal: 0 });
    expect(validWoundEventMetrics(m)).toBe(true);
  });
  it('rejects impossible infection/fatal/healing totals', () => {
    expect(validWoundEventMetrics({ wounded: 1, infected: 2, healed: 0, fatal: 0 })).toBe(false);
    expect(validWoundEventMetrics({ wounded: 1, infected: 0, healed: 0, fatal: 1 })).toBe(false);
    expect(validWoundEventMetrics({ wounded: 1, infected: 1, healed: 1, fatal: 1 })).toBe(false);
    expect(validWoundEventMetrics({ wounded: -1, infected: 0, healed: 0, fatal: 0 })).toBe(false);
  });
});
