import { GRID_SIZE, PATCH_METRES, positionInPatch,
  type EncounterPhase, type EncounterTrace, type Rng, type WorldPosition } from '@vana/shared';
import { resolveHunt, type HuntInput, type HuntStage } from './predation.js';

export interface SpatialHuntInput {
  predatorId: string; preyId: string; patchId: number; worldTime: number;
  predator: WorldPosition; prey: WorldPosition;
  predatorWalkMs: number; predatorSprintMs: number; preySprintMs: number;
  predatorSprintSeconds: number; preySprintSeconds: number; preyTrotMs: number;
  contactRadiusM: number; secondsAvailable: number; chaseStaminaCost: number;
  contest: Omit<HuntInput, 'distanceAtCommitM'>;
  /** Optional authoritative land-mask boundary; not a client collision approximation. */
  landBoundaryM?: (position: WorldPosition, heading: number) => number;
}
export interface SpatialHuntResult {
  killed: boolean;
  stage: HuntStage | 'approaching' | 'boundary_escape' | 'time_exhausted';
  staminaSpent: number;
  distanceAtCommitM: number;
  trace: EncounterTrace;
}

const distance = (a: WorldPosition, b: WorldPosition): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * A bounded local encounter, integrated before a kill may be committed. Both actors share a
 * timeline. Straight-line motion only for now: administrative patch boundaries do not stop a
 * chase. The edge of the entire world interrupts it rather than trapping prey. No decorative
 * obstacle claims are made.
 */
export function resolveSpatialHunt(input: SpatialHuntInput, rng: Rng): SpatialHuntResult {
  if (!positionInPatch(input.predator, input.patchId) || !positionInPatch(input.prey, input.patchId)) {
    throw new Error('encounter actors must have valid positions in the same patch');
  }
  const positive = [input.contactRadiusM, input.predatorWalkMs, input.predatorSprintMs,
    input.preySprintMs, input.preyTrotMs, input.predatorSprintSeconds, input.preySprintSeconds, input.contest.commitDistanceM];
  if (positive.some((n) => !Number.isFinite(n) || n <= 0)
    || !Number.isFinite(input.secondsAvailable) || input.secondsAvailable <= 0
    || !Number.isFinite(input.chaseStaminaCost) || input.chaseStaminaCost < 0
    || !Number.isFinite(input.worldTime) || input.predatorId === input.preyId
    || Object.values(input.contest).some((v) => typeof v === 'number' && !Number.isFinite(v))) {
    throw new Error('invalid encounter movement budget');
  }
  const predator = { ...input.predator }; const prey = { ...input.prey };
  const trace: EncounterTrace = {
    version: 1, predatorId: input.predatorId, preyId: input.preyId, patchId: input.patchId,
    startWorldTime: input.worldTime, contactRadiusM: input.contactRadiusM, samples: [],
  };
  let elapsed = 0; let spent = 0; let commitDistance = distance(predator, prey);
  const sample = (phase: EncounterPhase): void => {
    trace.samples.push({ seconds: elapsed, phase, predator: { ...predator }, prey: { ...prey } });
  };
  const finish = (stage: SpatialHuntResult['stage'], killed = false): SpatialHuntResult => ({
    stage, killed, staminaSpent: Math.min(1, spent), distanceAtCommitM: commitDistance, trace,
  });
  sample('approach');
  // A real stalk closes actual distance at walk speed, rather than inventing a random range.
  const closeBy = Math.max(0, commitDistance - input.contest.commitDistanceM);
  const approachSeconds = Math.min(closeBy / input.predatorWalkMs, input.secondsAvailable);
  if (approachSeconds > 0) {
    const heading = Math.atan2(prey.x - predator.x, prey.z - predator.z);
    predator.heading = heading;
    predator.x += Math.sin(heading) * input.predatorWalkMs * approachSeconds;
    predator.z += Math.cos(heading) * input.predatorWalkMs * approachSeconds;
    elapsed += approachSeconds; spent += approachSeconds / 3600 * 0.05;
    sample('stalk');
  }
  commitDistance = distance(predator, prey);
  if (commitDistance > input.contest.commitDistanceM + 1e-7) return finish('approaching');
  if (elapsed >= input.secondsAvailable) return finish('time_exhausted');

  const contest = resolveHunt({ ...input.contest, distanceAtCommitM: commitDistance }, rng);
  const availableStamina = Math.max(0, Math.min(1, input.contest.predatorStamina - spent));
  const sprintBudget = Math.min(180, input.predatorSprintSeconds * availableStamina);
  if (sprintBudget <= 0) { sample('abandon'); return finish('chase_abandoned'); }

  const away = Math.atan2(prey.x - predator.x, prey.z - predator.z);
  prey.heading = away; predator.heading = away;
  const vx = Math.sin(away); const vz = Math.cos(away);
  const min = -PATCH_METRES / 2 + 0.001;
  const max = (GRID_SIZE - 0.5) * PATCH_METRES - 0.001;
  const boundaryTime = (p: WorldPosition, speed: number): number => {
    if (speed <= 0) return Infinity;
    const tx = Math.abs(vx) < 1e-12 ? Infinity : ((vx > 0 ? max : min) - p.x) / (vx * speed);
    const tz = Math.abs(vz) < 1e-12 ? Infinity : ((vz > 0 ? max : min) - p.z) / (vz * speed);
    return Math.max(0, Math.min(tx, tz, (input.landBoundaryM?.(p, away) ?? Infinity) / speed));
  };
  const advance = (p: WorldPosition, speed: number, seconds: number): void => {
    p.x += vx * speed * seconds; p.z += vz * speed * seconds;
  };
  // Early detection leads to actual escape movement, not a fake chasing state on the predator.
  if (contest.stage === 'prey_alerted') {
    const seconds = Math.min(5, input.secondsAvailable - elapsed, boundaryTime(prey, input.preySprintMs));
    advance(prey, input.preySprintMs, seconds); elapsed += seconds; spent += 0.04;
    sample('escape'); return finish('prey_alerted');
  }

  sample('chase');
  let chaseSeconds = 0; let nextSample = 2;
  while (chaseSeconds < sprintBudget && elapsed < input.secondsAvailable) {
    const preySpeed = chaseSeconds < input.preySprintSeconds ? input.preySprintMs : input.preyTrotMs;
    const gap = distance(predator, prey) - input.contactRadiusM;
    const relativeSpeed = input.predatorSprintMs - preySpeed;
    const contactIn = gap <= 1e-7 ? 0 : relativeSpeed > 0 ? gap / relativeSpeed : Infinity;
    const edgeIn = Math.min(boundaryTime(prey, preySpeed), boundaryTime(predator, input.predatorSprintMs));
    const duration = Math.min(0.5, sprintBudget - chaseSeconds, input.secondsAvailable - elapsed,
      chaseSeconds < input.preySprintSeconds ? input.preySprintSeconds - chaseSeconds : Infinity);
    // The edge wins ties: it is an escape route, not an invisible trapping wall.
    if (edgeIn <= duration && edgeIn <= contactIn) {
      advance(predator, input.predatorSprintMs, edgeIn); advance(prey, preySpeed, edgeIn);
      elapsed += edgeIn; chaseSeconds += edgeIn;
      spent += input.chaseStaminaCost * chaseSeconds / input.predatorSprintSeconds;
      sample('escape'); return finish('boundary_escape');
    }
    if (contactIn <= duration) {
      advance(predator, input.predatorSprintMs, contactIn); advance(prey, preySpeed, contactIn);
      elapsed += contactIn; chaseSeconds += contactIn; sample('contact');
      spent += input.chaseStaminaCost * chaseSeconds / input.predatorSprintSeconds;
      if (contest.killed) return finish('killed', true);
      // A failed physical capture lets prey break away; a failed roll never creates a carcass.
      const escapeSeconds = Math.min(3, input.secondsAvailable - elapsed, boundaryTime(prey, preySpeed));
      advance(prey, preySpeed, escapeSeconds); elapsed += escapeSeconds;
      sample('escape'); return finish('escaped');
    }
    advance(predator, input.predatorSprintMs, duration); advance(prey, preySpeed, duration);
    elapsed += duration; chaseSeconds += duration;
    if (chaseSeconds >= nextSample) { sample('chase'); nextSample += 2; }
  }
  spent += input.chaseStaminaCost * chaseSeconds / input.predatorSprintSeconds;
  sample('abandon');
  return finish(elapsed >= input.secondsAvailable ? 'time_exhausted' : 'chase_abandoned');
}
