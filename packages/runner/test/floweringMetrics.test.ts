import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { emptyFloweringEventMetrics, recordFloweringEvent,
  validFloweringEventMetrics } from '../src/floweringMetrics.js';

const event = (type: WorldEvent['type'], biomassKg = 0, recycledKg = 0,
  outcome: WorldEvent['outcome'] = 'success'): WorldEvent => ({
  id: `test_${type}`, type, worldTime: 1, simVersion: 'test', patchId: 0, actors: [],
  conditions: {}, outcome, effects: { biomassKg, recycledKg },
  causalParents: [], confidence: 'authoritative',
});

describe('flowering guild milestone accounting', () => {
  it('counts only recorded finite transfers and distinguishes visit failure', () => {
    const metrics = emptyFloweringEventMetrics();
    for (const e of [event('fed'), event('flowering_started', 10),
      event('flower_visitation_settled', 8, 2), event('seeds_matured', 1.6, 6.4),
      event('plants_recruited', 0.3, 0.7), event('seed_bank_lost', 0, 0.6),
      event('flowering_started', 4), event('flower_visitation_settled', 0, 4, 'failure')])
      recordFloweringEvent(metrics, e);
    expect(metrics).toMatchObject({ blooms: 2, successfulVisits: 1, failedVisits: 1,
      seedMaturations: 1, recruitments: 1, seedLosses: 1, openedKg: 14,
      visitedKg: 8, seededKg: 1.6, recruitedKg: 0.3, recycledKg: 13.7 });
    expect(validFloweringEventMetrics(metrics)).toBe(true);
  });

  it('rejects impossible causal counts, masses, and non-finite event values', () => {
    const metrics = emptyFloweringEventMetrics();
    metrics.seedMaturations = 1;
    expect(validFloweringEventMetrics(metrics)).toBe(false);
    metrics.seedMaturations = 0;
    metrics.visitedKg = 1;
    expect(validFloweringEventMetrics(metrics)).toBe(false);
    metrics.visitedKg = 0;
    recordFloweringEvent(metrics, event('seeds_matured', Number.NaN));
    expect(validFloweringEventMetrics(metrics)).toBe(false);
  });
});
