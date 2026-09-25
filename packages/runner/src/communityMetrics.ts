import type { WorldEvent } from '@vana/shared';

export interface HumanFamilyMetrics {
  conceptions: number;
  births: number;
  pregnancyLosses: number;
  careEvents: number;
  careFoodKg: number;
  careWaterL: number;
}

export function emptyHumanFamilyMetrics(): HumanFamilyMetrics {
  return { conceptions: 0, births: 0, pregnancyLosses: 0, careEvents: 0, careFoodKg: 0, careWaterL: 0 };
}

/** Count the authoritative event stream, not the surviving descendants alone. */
export function recordHumanFamily(metrics: HumanFamilyMetrics, event: Pick<WorldEvent, 'type' | 'effects'>): void {
  switch (event.type) {
    case 'human_conceived': metrics.conceptions++; break;
    case 'human_born': metrics.births++; break;
    case 'human_pregnancy_lost': metrics.pregnancyLosses++; break;
    case 'human_cared':
      metrics.careEvents++;
      metrics.careFoodKg -= Number(event.effects.foodKg ?? 0);
      metrics.careWaterL -= Number(event.effects.waterL ?? 0);
      break;
    default: break;
  }
}

export function validHumanFamilyMetrics(metrics: HumanFamilyMetrics): boolean {
  return Object.values(metrics).every(value => Number.isFinite(value) && value >= 0)
    && metrics.births + metrics.pregnancyLosses <= metrics.conceptions;
}
