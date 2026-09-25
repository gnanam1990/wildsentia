import type { WorldEvent } from '@vana/shared';

/** Counts observed authoritative transitions, not a diagnosis inferred from deaths. */
export interface IllnessEventMetrics {
  contracted: number;
  symptomatic: number;
  recovered: number;
  fatal: number;
}

export const emptyIllnessEventMetrics = (): IllnessEventMetrics =>
  ({ contracted: 0, symptomatic: 0, recovered: 0, fatal: 0 });

export function recordIllnessEvent(metrics: IllnessEventMetrics, event: Pick<WorldEvent, 'type'>): void {
  switch (event.type) {
    case 'disease_contracted': metrics.contracted++; break;
    case 'disease_symptomatic': metrics.symptomatic++; break;
    case 'disease_recovered': metrics.recovered++; break;
    case 'disease_fatal': metrics.fatal++; break;
    default: break;
  }
}
