import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { emptyIllnessEventMetrics, recordIllnessEvent } from '../src/illnessMetrics.js';

describe('authoritative illness transition soak accounting', () => {
  it('counts the four event transitions exactly once and does not infer them from a death', () => {
    const metrics = emptyIllnessEventMetrics();
    for (const type of ['scavenged', 'disease_contracted', 'disease_symptomatic',
      'disease_recovered', 'disease_contracted', 'disease_symptomatic',
      'disease_fatal', 'died'] as WorldEvent['type'][]) {
      recordIllnessEvent(metrics, { type });
    }
    expect(metrics).toEqual({ contracted: 2, symptomatic: 2, recovered: 1, fatal: 1 });
  });
});
