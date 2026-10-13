import { positionInPatch, type Agent, type Patch, type Rng, type SpeciesConfig, type WorldPosition, type WorldGrid } from '@vana/shared';
import type { EventLog } from '../events/log.js';
import { navigate } from './navigation.js';
import { locateAgent, placeBeside } from './spatial.js';
import { attemptCourtship, conceive, endOestrus, isReceptive } from './reproduction.js';
import { breedingFertility } from './needs.js';

export interface CourtshipVisit {
  female: Agent; male: Agent; arrival: number; radius: number; relatedness: number; routeId?: string;
}

/** Explicit coarse-tick policy: travel to a perceived start-of-hour location, then attempt
 * courtship only if both animals are still receptive and in contact at the hour's end.
 * Arrival alone never implies mating; no male is teleported or held still by this function. */
export function approachMate(grid: WorldGrid, female: Agent, male: Agent, target: { patchId: number; position: WorldPosition },
  cfg: SpeciesConfig, patches: Patch[], start: number, hours: number, relatedness: number, log: EventLog): CourtshipVisit {
  const radius = Math.max(.5, cfg.body.shoulderHeightM);
  female.currentGoal = 'breed'; female.alternativeGoal = null; female.goalScore = 1; female.targetId = male.id;
  const from = female.patchId, here = locateAgent(grid, female);
  if (female.patchId === target.patchId && Math.hypot(here.x - target.position.x, here.z - target.position.z) <= radius) {
    delete female.journey; female.state = 'resting';
    return { female, male, arrival: start, radius, relatedness };
  }
  const slot = { ...female, patchId: target.patchId };
  placeBeside(grid, slot, target.position, radius * .5);
  const movement = navigate(grid, female, cfg, patches, target.patchId, 'breed', start, hours * 3600, false, slot.position!);
  female.state = movement.trace.completed || movement.unreachable ? 'resting' : 'travelling';
  const event = log.append({ type: 'moved', worldTime: Math.floor(start + movement.seconds), simVersion: '',
    patchId: female.patchId, actors: [female.id], goal: 'breed',
    conditions: { reason: 'approach_mate', from, destination: target.patchId, mateId: male.id,
      targetX: target.position.x, targetZ: target.position.z, contactRadiusM: radius },
    outcome: movement.unreachable ? 'abandoned' : movement.trace.completed ? 'success' : 'interrupted',
    effects: { distanceM: movement.distanceM, durationSeconds: movement.seconds, sprintSeconds: 0 },
    causalParents: [], confidence: 'authoritative', movement: movement.trace });
  return { female, male, arrival: movement.trace.completed ? start + movement.seconds : Infinity, radius, relatedness, routeId: event.id };
}

/** Instantaneous end-of-tick trial, not a measured mating-duration or courtship animation. */
export function finishCourtship(grid: WorldGrid, visit: CourtshipVisit, cfg: SpeciesConfig, start: number, end: number,
  localDensity: number, rng: Rng, log: EventLog, breedingAllowed = true): void {
  if (visit.arrival > end) return;
  const { female, male, radius } = visit;
  const contact = female.alive && male.alive && (female.altitudeM ?? 0) === 0 && (male.altitudeM ?? 0) === 0
    && positionInPatch(grid, female.position, female.patchId)
    && positionInPatch(grid, male.position, male.patchId)
    && Math.hypot(female.position.x - male.position.x, female.position.z - male.position.z) <= radius + 1e-8;
  const receptive = contact && breedingAllowed && isReceptive(female, cfg, end) && isReceptive(male, cfg, end)
    && female.drives.fear < .5 && male.drives.fear < .5 && female.lastEncounterAt !== start && male.lastEncounterAt !== start;
  const success = receptive && attemptCourtship(female, male, rng, localDensity, cfg.social.groupSize[1],
    breedingFertility(female, cfg));
  log.append({ type: 'courtship', worldTime: end, simVersion: '', patchId: female.patchId,
    ...(positionInPatch(grid, female.position, female.patchId) ? { position: { ...female.position } } : {}),
    actors: [female.id, male.id], goal: 'breed',
    conditions: { species: female.speciesId, relatedness: visit.relatedness, contactRadiusM: radius,
      policy: 'end_of_tick_contact_trial', reason: !contact ? 'contact_lost' : !breedingAllowed ? 'pack_breeding_limit' : !receptive ? 'not_receptive' : 'contact_trial',
      ...(contact ? { maleX: male.position!.x, maleZ: male.position!.z } : {}) },
    outcome: !receptive ? 'interrupted' : success ? 'success' : 'failure', effects: {},
    causalParents: visit.routeId ? [visit.routeId] : [], confidence: 'authoritative' });
  if (!receptive) return;
  if (success) conceive(female, male, end);
  else endOestrus(female, cfg, end);
}
