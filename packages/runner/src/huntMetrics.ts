import type { WorldEvent } from '@vana/shared';

export interface HuntMetrics {
  attempts: number;
  kills: number;
  contacts: number;
  stages: Record<string, number>;
  prey: Record<string, number>;
  seconds: number;
}

/** Count recorded evidence, not a species-wide success rate inferred from population change. */
export function recordHunt(metrics: Record<string, HuntMetrics>, event: WorldEvent): void {
  if (event.type !== 'hunt') return;
  const species = String(event.conditions.predatorSpecies ?? 'unknown');
  const prey = String(event.conditions.preySpecies ?? 'unknown');
  const m = metrics[species] ??= { attempts: 0, kills: 0, contacts: 0, stages: {}, prey: {}, seconds: 0 };
  m.attempts++;
  if (event.outcome === 'success') m.kills++;
  if (event.encounter?.samples.some((s) => s.phase === 'contact')) m.contacts++;
  const stage = String(event.conditions.stage ?? 'unknown');
  m.stages[stage] = (m.stages[stage] ?? 0) + 1;
  m.prey[prey] = (m.prey[prey] ?? 0) + 1;
  const seconds = event.conditions.durationSeconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) m.seconds += seconds;
}
