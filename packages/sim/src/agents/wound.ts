import { positionInPatch, type Agent, type Rng, type WorldEvent, type Wound, type WorldGrid } from '@vana/shared';
import type { EventLog } from '../events/log.js';

/** Scenario coefficients only. No cited field study estimates a tiger–chital/sambar
 * per-contact wound rate, spontaneous recovery time or wound-infection risk. */
export const WOUND_POLICY = Object.freeze({
  probabilityGivenFailedContact: 0.08,
  severityMin: 0.15, severityMax: 0.45,
  recoveryMinHours: 72, recoveryMaxHours: 168,
  infectionHazardPerDay: 0.04,
  infectedFatalHazardPerDay: 0.005,
  maxLocomotionPenalty: 0.4,
});

const INITIAL_PREY = new Set(['chital', 'sambar']);
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function woundMobilityFactor(agent: Pick<Agent, 'wound'>): number {
  return agent.wound ? 1 - WOUND_POLICY.maxLocomotionPenalty * agent.wound.severity : 1;
}

/** Reject corrupted persisted episodes, including impossible future progression. */
export function validateWound(wound: Wound | undefined, checkpointTime: number): void {
  if (wound === undefined) return;
  if (!wound || wound.kind !== 'contact_injury' || !['open', 'infected'].includes(wound.phase)
    || [wound.sourceHuntEventId, wound.woundEventId].some(id => typeof id !== 'string' || !id.length)
    || (wound.phase === 'infected' && (typeof wound.infectionEventId !== 'string' || !wound.infectionEventId.length))
    || (wound.phase === 'open' && wound.infectionEventId !== undefined)
    || [wound.acquiredAt, wound.lastUpdatedAt, wound.severity, wound.recoveryRemainingHours,
      wound.infectionBudget, wound.mortalityBudget].some(n => !Number.isFinite(n))
    || wound.acquiredAt < 0 || wound.acquiredAt > wound.lastUpdatedAt
    || wound.lastUpdatedAt > checkpointTime || wound.severity <= 0 || wound.severity > 1
    || wound.recoveryRemainingHours < 0 || wound.infectionBudget < 0 || wound.mortalityBudget < 0
    || (wound.phase === 'infected' && wound.infectionBudget > 1e-10)) {
    throw new Error('invalid wound checkpoint');
  }
}

/** Only a documented failed physical capture can create a survivor wound. A chase, alert,
 * boundary escape, successful kill or already-active wound never authorizes a new episode. */
export function exposeToContactWound(grid: WorldGrid, prey: Agent, hunt: WorldEvent, decisionEnd: number,
  rng: Rng, log: EventLog): boolean {
  if (!prey.alive || prey.wound || !INITIAL_PREY.has(prey.speciesId)
    || hunt.type !== 'hunt' || hunt.outcome !== 'failure' || hunt.conditions.stage !== 'escaped'
    || hunt.actors[1] !== prey.id || hunt.encounter?.preyId !== prey.id
    || !hunt.encounter.samples.some(sample => sample.phase === 'contact')
    || !Number.isFinite(decisionEnd) || decisionEnd < hunt.worldTime
    || !positionInPatch(grid, prey.position, prey.patchId)
    || !rng.bool(WOUND_POLICY.probabilityGivenFailedContact)) return false;
  const severity = rng.range(WOUND_POLICY.severityMin, WOUND_POLICY.severityMax);
  const recoveryRemainingHours = rng.range(WOUND_POLICY.recoveryMinHours, WOUND_POLICY.recoveryMaxHours);
  const infectionBudget = -Math.log(Math.max(Number.EPSILON, 1 - rng.next()));
  const mortalityBudget = -Math.log(Math.max(Number.EPSILON, 1 - rng.next()));
  const acquiredAt = hunt.worldTime;
  const wounded = log.append({ type: 'wounded', worldTime: acquiredAt, simVersion: '',
    patchId: prey.patchId, position: { ...prey.position }, actors: [prey.id, hunt.actors[0]!],
    conditions: { kind: 'contact_injury', sourceHuntEventId: hunt.id,
      model: 'uncalibrated_contact_wound_v1', timing: 'hunt_end_observation' },
    outcome: 'success', effects: { severity, contactCount: hunt.encounter.samples.filter(s => s.phase === 'contact').length },
    causalParents: [hunt.id], confidence: 'authoritative' });
  // The remaining part of this coarse decision cannot heal or infect a wound retroactively.
  prey.wound = { kind: 'contact_injury', phase: 'open', sourceHuntEventId: hunt.id,
    woundEventId: wounded.id, acquiredAt, lastUpdatedAt: decisionEnd, severity,
    recoveryRemainingHours, infectionBudget, mortalityBudget };
  return true;
}

/** Settle one bounded wound at decision end. A fatal event is returned to World so its
 * existing death/carcass path remains the only mass-accounting authority. */
export function advanceWound(agent: Agent, end: number, log: EventLog): WorldEvent | null {
  const wound = agent.wound;
  if (!agent.alive || !wound) return null;
  if (!Number.isFinite(end) || end < wound.lastUpdatedAt) throw new Error('wound time must not run backwards');
  if (end === wound.lastUpdatedAt) return null;
  const hours = (end - wound.lastUpdatedAt) / 3600;
  wound.lastUpdatedAt = end;
  const resistance = clamp01(agent.traits.diseaseResistance);
  const deficit = clamp01(Math.max(agent.drives.hunger, agent.drives.thirst));
  const recoveryRate = (0.5 + resistance * 0.3 + (agent.state === 'resting' ? 0.2 : 0))
    * (1 - deficit * 0.5) * (wound.phase === 'infected' ? 0.65 : 1);
  const hazardPerHour = (wound.phase === 'open'
    ? WOUND_POLICY.infectionHazardPerDay : WOUND_POLICY.infectedFatalHazardPerDay)
    / 24 * wound.severity * (1 - resistance * 0.5) * (1 + deficit);
  const recoveryIn = wound.recoveryRemainingHours / recoveryRate;
  const hazardBudget = wound.phase === 'open' ? wound.infectionBudget : wound.mortalityBudget;
  const hazardIn = hazardPerHour > 0 ? hazardBudget / hazardPerHour : Infinity;
  const affectedHours = Math.min(hours, recoveryIn, hazardIn);
  wound.recoveryRemainingHours = Math.max(0, wound.recoveryRemainingHours - affectedHours * recoveryRate);
  if (wound.phase === 'open') wound.infectionBudget = Math.max(0, wound.infectionBudget - affectedHours * hazardPerHour);
  else wound.mortalityBudget = Math.max(0, wound.mortalityBudget - affectedHours * hazardPerHour);
  agent.drives.fatigue = clamp01(agent.drives.fatigue + affectedHours * wound.severity * 0.01);
  agent.drives.hunger = clamp01(agent.drives.hunger + affectedHours / 24 * wound.severity * 0.04);
  const append = (type: 'wound_infected' | 'wound_healed' | 'wound_infection_fatal'): WorldEvent =>
    log.append({ type, worldTime: end, simVersion: '', patchId: agent.patchId,
      ...(positionInPatch(log.grid, agent.position, agent.patchId) ? { position: { ...agent.position } } : {}),
      actors: [agent.id], conditions: { kind: 'contact_injury', sourceHuntEventId: wound.sourceHuntEventId,
        timing: 'decision_end', model: 'uncalibrated_contact_wound_v1' },
      outcome: 'success', effects: { severity: wound.severity, activeHours: affectedHours },
      causalParents: [wound.infectionEventId ?? wound.woundEventId], confidence: 'authoritative' });
  if (recoveryIn <= hours && recoveryIn <= hazardIn) {
    append('wound_healed');
    delete agent.wound;
    return null;
  }
  if (hazardIn <= hours) {
    if (wound.phase === 'open') {
      wound.phase = 'infected';
      wound.infectionEventId = append('wound_infected').id;
      return null;
    }
    return append('wound_infection_fatal');
  }
  return null;
}
