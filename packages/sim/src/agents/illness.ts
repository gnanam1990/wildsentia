import { positionInPatch, type Agent, type Carcass, type Illness, type Rng,
  type SpeciesConfig, type WorldEvent } from '@vana/shared';
import type { EventLog } from '../events/log.js';

/** Explicit model policies, NOT species-calibrated veterinary/epidemiological parameters. */
export const CARRION_ILLNESS_POLICY = Object.freeze({
  hazardPerDailyRation: 0.08,
  incubationMinHours: 6, incubationMaxHours: 18,
  recoveryMinHours: 72, recoveryMaxHours: 168,
  fatalHazardPerDay: 0.01,
});
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Reject malformed persisted state instead of curing it or rerolling a disease episode. */
export function validateIllness(illness: Illness | undefined, checkpointTime: number): void {
  if (illness === undefined) return;
  if (!illness || illness.kind !== 'carrion_infection'
    || !['incubating', 'active'].includes(illness.phase)
    || [illness.sourceCarcassId, illness.sourceMealEventId, illness.contractedEventId]
      .some(id => typeof id !== 'string' || !id.length)
    || (illness.phase === 'active' && (typeof illness.onsetEventId !== 'string' || !illness.onsetEventId.length))
    || [illness.acquiredAt, illness.incubationUntil, illness.lastUpdatedAt, illness.severity,
      illness.recoveryRemainingHours, illness.mortalityBudget].some(n => !Number.isFinite(n))
    || illness.acquiredAt < 0 || illness.acquiredAt > illness.lastUpdatedAt
    || illness.lastUpdatedAt > checkpointTime || illness.incubationUntil <= illness.acquiredAt
    || (illness.phase === 'active' && illness.lastUpdatedAt < illness.incubationUntil)
    || illness.severity <= 0 || illness.severity > 1
    || illness.recoveryRemainingHours < 0 || illness.mortalityBudget < 0) {
    throw new Error('invalid illness checkpoint');
  }
}

/** Only an actual completed meal can expose its consumer. No nearby-carcass infection. */
export function exposeToCarrion(agent: Agent, species: SpeciesConfig, carcass: Carcass,
  meal: WorldEvent, dailyFoodKg: number, rng: Rng, log: EventLog): boolean {
  if (!agent.alive || agent.illness || (meal.type !== 'fed' && meal.type !== 'scavenged')
    || meal.outcome !== 'success' || meal.actors[0] !== agent.id
    || meal.conditions.carcassId !== carcass.id || meal.actors[1] !== carcass.originId
    || !Number.isFinite(meal.effects.kg) || !(meal.effects.kg! > 0)
    || !Number.isFinite(dailyFoodKg) || dailyFoodKg <= 0
    || typeof meal.conditions.feedingSeconds !== 'number' || meal.conditions.feedingSeconds <= 0
    || !Number.isFinite(meal.conditions.feedingSeconds)
    || !Number.isFinite(meal.worldTime) || meal.worldTime < carcass.diedAt
    || !Number.isFinite(carcass.pathogenLoad) || carcass.pathogenLoad <= 0) return false;
  const resistance = clamp01(agent.traits.diseaseResistance);
  const dose = meal.effects.kg! / dailyFoodKg;
  const hazard = CARRION_ILLNESS_POLICY.hazardPerDailyRation * dose
    * clamp01(carcass.pathogenLoad) * (1 - clamp01(species.diet.carrionTolerance))
    * (1 - resistance * 0.5);
  if (hazard <= 0 || !rng.bool(-Math.expm1(-hazard))) return false;
  const acquiredAt = meal.worldTime;
  const severity = (0.2 + rng.next() * 0.5) * (1 - resistance * 0.3);
  const incubationUntil = acquiredAt + rng.range(CARRION_ILLNESS_POLICY.incubationMinHours,
    CARRION_ILLNESS_POLICY.incubationMaxHours) * 3600;
  const recoveryRemainingHours = rng.range(CARRION_ILLNESS_POLICY.recoveryMinHours,
    CARRION_ILLNESS_POLICY.recoveryMaxHours);
  const mortalityBudget = -Math.log(Math.max(Number.EPSILON, 1 - rng.next()));
  const contracted = log.append({ type: 'disease_contracted', worldTime: acquiredAt,
    simVersion: '', patchId: meal.patchId, ...(meal.position ? { position: { ...meal.position } } : {}),
    actors: [agent.id], conditions: { kind: 'carrion_infection', sourceCarcassId: carcass.id,
      sourceMealEventId: meal.id, sourceAnimalId: carcass.originId, pathogenLoad: carcass.pathogenLoad,
      carrionTolerance: species.diet.carrionTolerance, diseaseResistance: resistance,
      incubationUntil, model: 'generic_carrion_v1' },
    outcome: 'success', effects: { consumedKg: meal.effects.kg!, doseDailyRations: dose, severity },
    causalParents: [meal.id], confidence: 'authoritative' });
  agent.illness = { kind: 'carrion_infection', phase: 'incubating', sourceCarcassId: carcass.id,
    sourceMealEventId: meal.id, contractedEventId: contracted.id, acquiredAt, incubationUntil,
    lastUpdatedAt: acquiredAt, severity, recoveryRemainingHours, mortalityBudget };
  return true;
}

/**
 * Health is settled at decision end, after actions. Transition timestamps are observation
 * times, not invented sub-tick positions. Only elapsed active time consumes recovery/hazard;
 * an infection acquired by an end-of-tick meal cannot progress retroactively in that tick.
 * Returns a fatal event for World to use with its sole carcass/death accounting path.
 */
export function advanceIllness(agent: Agent, end: number, log: EventLog): WorldEvent | null {
  const illness = agent.illness;
  if (!agent.alive || !illness) return null;
  if (!Number.isFinite(end) || end < illness.lastUpdatedAt) throw new Error('illness time must not run backwards');
  if (end === illness.lastUpdatedAt) return null;
  const activeHours = Math.max(0, end - Math.max(illness.lastUpdatedAt, illness.incubationUntil)) / 3600;
  illness.lastUpdatedAt = end;
  if (end < illness.incubationUntil) return null;
  const append = (type: 'disease_symptomatic' | 'disease_recovered' | 'disease_fatal',
    effects: Record<string, number>): WorldEvent => log.append({ type, worldTime: end, simVersion: '',
    patchId: agent.patchId, ...(positionInPatch(log.grid, agent.position, agent.patchId) ? { position: { ...agent.position } } : {}),
    actors: [agent.id], conditions: { kind: illness.kind, sourceCarcassId: illness.sourceCarcassId,
      sourceMealEventId: illness.sourceMealEventId, incubationUntil: illness.incubationUntil,
      timing: 'decision_end', model: 'generic_carrion_v1' }, outcome: 'success', effects,
    causalParents: [illness.onsetEventId ?? illness.contractedEventId], confidence: 'authoritative' });
  if (illness.phase === 'incubating') {
    illness.phase = 'active';
    illness.onsetEventId = append('disease_symptomatic', { severity: illness.severity }).id;
  }
  if (activeHours === 0) return null;
  const resistance = clamp01(agent.traits.diseaseResistance);
  const deficit = clamp01(Math.max(agent.drives.hunger, agent.drives.thirst));
  const recoveryRate = (0.5 + resistance * 0.5 + (agent.state === 'resting' ? 0.35 : 0)) * (1 - deficit * 0.5);
  const hazardPerHour = CARRION_ILLNESS_POLICY.fatalHazardPerDay / 24 * illness.severity
    * (1 - resistance * 0.75) * (1 + deficit * 2);
  const recoveryIn = illness.recoveryRemainingHours / recoveryRate;
  const fatalIn = illness.mortalityBudget / hazardPerHour;
  const affectedHours = Math.min(activeHours, recoveryIn, fatalIn);
  illness.recoveryRemainingHours = Math.max(0, illness.recoveryRemainingHours - affectedHours * recoveryRate);
  illness.mortalityBudget = Math.max(0, illness.mortalityBudget - affectedHours * hazardPerHour);
  agent.drives.fatigue = clamp01(agent.drives.fatigue + affectedHours * illness.severity * 0.025);
  agent.drives.thirst = clamp01(agent.drives.thirst + affectedHours / 24 * illness.severity * 0.08);
  if (fatalIn <= activeHours && fatalIn <= recoveryIn) {
    return append('disease_fatal', { severity: illness.severity, activeHours: affectedHours });
  }
  if (recoveryIn <= activeHours) {
    append('disease_recovered', { severity: illness.severity, activeHours: affectedHours });
    delete agent.illness;
  }
  return null;
}
