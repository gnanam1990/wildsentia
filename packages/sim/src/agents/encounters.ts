import { positionInPatch, worldExtentM, type WorldGrid,
  type EncounterPhase, type EncounterTrace, type Rng, type WorldPosition } from '@vana/shared';
import { resolveHunt, type HuntInput, type HuntStage } from './predation.js';

export interface SpatialHuntInput {
  grid: WorldGrid;
  predatorId: string; preyId: string; patchId: number; worldTime: number;
  predator: WorldPosition; prey: WorldPosition;
  predatorWalkMs: number; predatorSprintMs: number; preySprintMs: number;
  predatorSprintSeconds: number; preySprintSeconds: number; preyTrotMs: number;
  contactRadiusM: number; secondsAvailable: number; chaseStaminaCost: number;
  /**
   * sim_0.36.0: seconds from a killing contact to the prey's death (the bite and hold). The prey
   * dies at the end of the subdue phase, not on touch. Omitted or 0: legacy death at contact.
   */
  subdueSeconds?: number;
  /** Metres the seized prey drags its killer before it goes down (0 when omitted). */
  subdueDragM?: number;
  /**
   * Chance that a seized prey breaks free during the hold, fights off its killer and runs
   * (0 when omitted): the hunt then fails after contact, as a `broke_free` stage.
   */
  subdueBreakFreeChance?: number;
  contest: Omit<HuntInput, 'distanceAtCommitM'>;
  /** Optional authoritative land-mask boundary; not a client collision approximation. */
  landBoundaryM?: (position: WorldPosition, heading: number) => number;
}
export interface SpatialHuntResult {
  killed: boolean;
  stage: HuntStage | 'approaching' | 'boundary_escape' | 'time_exhausted' | 'broke_free';
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
  if (!positionInPatch(input.grid, input.predator, input.patchId) || !positionInPatch(input.grid, input.prey, input.patchId)) {
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
  const extent = worldExtentM(input.grid);
  const min = extent.min + 0.001;
  const boundaryTime = (p: WorldPosition, speed: number): number => {
    if (speed <= 0) return Infinity;
    const tx = Math.abs(vx) < 1e-12 ? Infinity : ((vx > 0 ? extent.maxX - 0.001 : min) - p.x) / (vx * speed);
    const tz = Math.abs(vz) < 1e-12 ? Infinity : ((vz > 0 ? extent.maxZ - 0.001 : min) - p.z) / (vz * speed);
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

  /**
   * The hold after a killing contact (sim_0.36.0). The prey keeps a little way on along its line
   * of flight (it is pulled down or drags its killer a few metres, easing to a stop) with a small
   * side-to-side struggle; the predator stays within the contact radius, on its quarter. Samples
   * every 2-5 s, and the last one is the moment of death. Pure arithmetic: no random draw.
   */
  const subdue = (seconds: number, fatal = true): void => {
    if (!(seconds > 0)) return;
    const from = { ...prey }, hold = Math.min(input.contactRadiusM * 0.6, distance(predator, prey));
    const drag = Math.max(0, Math.min((input.subdueDragM ?? 0) * (fatal ? 1 : 0.5), boundaryTime(prey, 1)));
    const step = Math.min(5, Math.max(2, seconds / 12));
    const start = elapsed;
    for (let t = Math.min(step, seconds); ; t = Math.min(t + step, seconds)) {
      const f = t / seconds, along = drag * (1 - (1 - f) ** 2), sway = 0.25 * Math.sin(t * 1.3) * (1 - f);
      prey.x = from.x + vx * along + vz * sway; prey.z = from.z + vz * along - vx * sway;
      predator.x = prey.x - vx * hold; predator.z = prey.z - vz * hold;
      elapsed = start + t;
      sample('subdue');
      if (t >= seconds) break;
    }
  };

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
      if (contest.killed) {
        const hold = Math.min(input.subdueSeconds ?? 0, input.secondsAvailable - elapsed);
        // A seized animal that fights free does so partway through the hold, then runs.
        if (hold > 0 && (input.subdueBreakFreeChance ?? 0) > 0 && rng.bool(input.subdueBreakFreeChance!)) {
          subdue(hold * (0.2 + 0.6 * rng.next()), false);
          const escapeSeconds = Math.min(3, input.secondsAvailable - elapsed, boundaryTime(prey, preySpeed));
          advance(prey, preySpeed, escapeSeconds); elapsed += escapeSeconds;
          sample('escape'); return finish('broke_free');
        }
        subdue(hold);
        return finish('killed', true);
      }
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
