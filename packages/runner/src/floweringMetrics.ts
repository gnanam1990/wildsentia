import type { WorldEvent } from '@vana/shared';

export interface FloweringEventMetrics {
  blooms: number;
  visitationSettlements: number;
  successfulVisits: number;
  failedVisits: number;
  seedMaturations: number;
  recruitments: number;
  seedLosses: number;
  openedKg: number;
  visitedKg: number;
  seededKg: number;
  recruitedKg: number;
  recycledKg: number;
}

export const emptyFloweringEventMetrics = (): FloweringEventMetrics => ({
  blooms: 0, visitationSettlements: 0, successfulVisits: 0, failedVisits: 0,
  seedMaturations: 0, recruitments: 0, seedLosses: 0, openedKg: 0,
  visitedKg: 0, seededKg: 0, recruitedKg: 0, recycledKg: 0,
});

/** Count only authoritative, aggregate guild milestones; no individual insect is implied. */
export function recordFloweringEvent(metrics: FloweringEventMetrics, event: WorldEvent): void {
  switch (event.type) {
    case 'flowering_started':
      metrics.blooms++;
      metrics.openedKg += Number(event.effects.biomassKg);
      break;
    case 'flower_visitation_settled':
      metrics.visitationSettlements++;
      if (event.outcome === 'success') metrics.successfulVisits++;
      else metrics.failedVisits++;
      metrics.visitedKg += Number(event.effects.biomassKg);
      metrics.recycledKg += Number(event.effects.recycledKg);
      break;
    case 'seeds_matured':
      metrics.seedMaturations++;
      metrics.seededKg += Number(event.effects.biomassKg);
      metrics.recycledKg += Number(event.effects.recycledKg);
      break;
    case 'plants_recruited':
      metrics.recruitments++;
      metrics.recruitedKg += Number(event.effects.biomassKg);
      metrics.recycledKg += Number(event.effects.recycledKg);
      break;
    case 'seed_bank_lost':
      metrics.seedLosses++;
      metrics.recycledKg += Number(event.effects.recycledKg);
      break;
    default: break;
  }
}

export function validFloweringEventMetrics(metrics: FloweringEventMetrics): boolean {
  const counts = [metrics.blooms, metrics.visitationSettlements, metrics.successfulVisits,
    metrics.failedVisits, metrics.seedMaturations, metrics.recruitments, metrics.seedLosses];
  const mass = [metrics.openedKg, metrics.visitedKg, metrics.seededKg,
    metrics.recruitedKg, metrics.recycledKg];
  return counts.every(value => Number.isSafeInteger(value) && value >= 0)
    && mass.every(value => Number.isFinite(value) && value >= 0)
    && metrics.visitationSettlements <= metrics.blooms
    && metrics.successfulVisits + metrics.failedVisits === metrics.visitationSettlements
    && metrics.seedMaturations <= metrics.successfulVisits
    && metrics.visitedKg <= metrics.openedKg + 1e-6
    && metrics.seededKg <= metrics.visitedKg + 1e-6
    && metrics.recruitedKg <= metrics.seededKg + 1e-6;
}
