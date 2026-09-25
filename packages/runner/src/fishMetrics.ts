import type { WorldEvent } from '@vana/shared';

export interface FishEventMetrics {
  spawned: number;
  hatched: number;
  recruited: number;
  cohortLost: number;
}

export const emptyFishEventMetrics = (): FishEventMetrics =>
  ({ spawned: 0, hatched: 0, recruited: 0, cohortLost: 0 });

/** Count recorded cohort milestones, never infer recruitment from adult stock growth. */
export function recordFishEvent(metrics: FishEventMetrics, event: WorldEvent): void {
  switch (event.type) {
    case 'fish_spawned': metrics.spawned++; break;
    case 'fish_hatched': metrics.hatched++; break;
    case 'fish_recruited': metrics.recruited++; break;
    case 'fish_cohort_lost': metrics.cohortLost++; break;
    default: break;
  }
}

export function validFishEventMetrics(metrics: FishEventMetrics): boolean {
  return Object.values(metrics).every(value => Number.isSafeInteger(value) && value >= 0)
    && metrics.hatched <= metrics.spawned
    && metrics.recruited <= metrics.hatched
    && metrics.recruited + metrics.cohortLost <= metrics.spawned;
}
