import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { emptyHumanFamilyMetrics, recordHumanFamily, validHumanFamilyMetrics } from '../src/communityMetrics.js';

const event = (type: WorldEvent['type'], effects: WorldEvent['effects'] = {}) => ({ type, effects });

describe('authoritative human-family soak accounting', () => {
  it('counts conception, both outcomes and finite delivered care without inventing births from state size', () => {
    const metrics = emptyHumanFamilyMetrics();
    for (const e of [event('human_conceived'), event('human_conceived'), event('human_born'),
      event('human_pregnancy_lost', { returnedKg: 1 }),
      event('human_cared', { foodKg: -.35, waterL: -.6, childGrowthKg: .01 }), event('died')]) {
      recordHumanFamily(metrics, e);
    }
    expect(metrics).toEqual({ conceptions: 2, births: 1, pregnancyLosses: 1, careEvents: 1,
      careFoodKg: .35, careWaterL: .6 });
    expect(validHumanFamilyMetrics(metrics)).toBe(true);
  });

  it('fails impossible or malformed event totals instead of giving a green soak', () => {
    const metrics = emptyHumanFamilyMetrics();
    recordHumanFamily(metrics, event('human_born'));
    expect(validHumanFamilyMetrics(metrics)).toBe(false);
    metrics.conceptions = 1;
    recordHumanFamily(metrics, event('human_cared', { foodKg: Number.NaN }));
    expect(validHumanFamilyMetrics(metrics)).toBe(false);
  });
});
