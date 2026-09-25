import type { WorldEvent } from '@vana/shared';

export interface WoundEventMetrics {
  wounded: number;
  infected: number;
  healed: number;
  fatal: number;
}

export const emptyWoundEventMetrics = (): WoundEventMetrics =>
  ({ wounded: 0, infected: 0, healed: 0, fatal: 0 });

/** Tally authoritative episode milestones, not generic failed hunts or inferred symptoms. */
export function recordWoundEvent(metrics: WoundEventMetrics, event: WorldEvent): void {
  switch (event.type) {
    case 'wounded': metrics.wounded++; break;
    case 'wound_infected': metrics.infected++; break;
    case 'wound_healed': metrics.healed++; break;
    case 'wound_infection_fatal': metrics.fatal++; break;
    default: break;
  }
}

export function validWoundEventMetrics(metrics: WoundEventMetrics): boolean {
  const values = Object.values(metrics);
  return values.every(v => Number.isSafeInteger(v) && v >= 0)
    && metrics.infected <= metrics.wounded
    && metrics.healed + metrics.fatal <= metrics.wounded
    && metrics.fatal <= metrics.infected;
}
