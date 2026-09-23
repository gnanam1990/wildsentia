import type { Agent, Rng } from '@vana/shared';

export type HuntStage =
  | 'out_of_range' | 'detected' | 'prey_alerted' | 'chase_abandoned' | 'escaped' | 'killed';

export interface HuntInput {
  /** Species baseline against an unaware, healthy adult in the open. */
  baseSuccess: number;
  stalkConcealment: number;
  canopyCover: number;
  predatorStamina: number;
  predatorCondition: number;
  preyEvasiveness: number;
  preyCondition: number;
  preyAlert: boolean;
  herdSize: number;
  distanceAtCommitM: number;
  commitDistanceM: number;
}

export interface HuntOutcome {
  stage: HuntStage;
  killed: boolean;
  staminaSpent: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Resolves one predation attempt from simulation variables alone.
 *
 * Pure: no world access, no clock, no model. Every factor here is something the simulation
 * already tracks, which is what lets a failed hunt be explained afterwards from the event
 * record rather than narrated from imagination.
 */
export function resolveHunt(input: HuntInput, rng: Rng): HuntOutcome {
  // A commit far outside the species' working distance is not a hunt at all.
  if (input.distanceAtCommitM > input.commitDistanceM * 4) {
    return { stage: 'out_of_range', killed: false, staminaSpent: 0 };
  }

  // Concealment: the predator's own stalking ability, helped by the cover it is moving through.
  const concealment = clamp01(input.stalkConcealment * (0.55 + input.canopyCover * 0.45));

  // Vigilance rises with herd size — more eyes, earlier detection. Logarithmic, because the
  // tenth animal adds far less than the second.
  const vigilance = clamp01(0.20 + Math.log2(Math.max(input.herdSize, 1) + 1) * 0.14);

  const detectionChance = clamp01(vigilance * (1 - concealment) + (input.preyAlert ? 0.45 : 0));
  const detected = rng.bool(detectionChance);

  if (detected && rng.bool(0.45)) {
    // Spotted before the commit. Cheap failure — the predator has spent almost nothing.
    return { stage: 'prey_alerted', killed: false, staminaSpent: 0.04 };
  }

  // Closing distance matters: past the species' commit distance, odds fall away quickly.
  const distanceFactor = clamp01(1 - Math.max(0, input.distanceAtCommitM - input.commitDistanceM)
    / (input.commitDistanceM * 3));

  const staminaFactor = clamp01(input.predatorStamina) ** 1.5;
  const conditionFactor = 0.55 + clamp01(input.predatorCondition) * 0.45;
  // Evasiveness is scaled down deliberately. Real solitary-ambush success is nearer 10%, but
  // the spec fixes a 20-35% band (§4.3) so that failure reads as ordinary rather than as the
  // rule, and these weights are what put the model inside it.
  const escapeFactor = 1 - clamp01(input.preyEvasiveness) * (0.22 + clamp01(input.preyCondition) * 0.22);
  const alertPenalty = detected ? 0.45 : 1;

  const chance = clamp01(
    input.baseSuccess * distanceFactor * staminaFactor * conditionFactor * escapeFactor * alertPenalty,
  );

  const staminaSpent = clamp01(0.12 + (1 - distanceFactor) * 0.2 + rng.next() * 0.12);

  if (rng.bool(chance)) return { stage: 'killed', killed: true, staminaSpent };

  // A failed commit is either broken off by the predator or outrun by the prey.
  const abandoned = input.predatorStamina < 0.35 || rng.bool(0.4);
  return {
    stage: abandoned ? 'chase_abandoned' : 'escaped',
    killed: false,
    staminaSpent,
  };
}

export interface PreyCandidate {
  agent: Agent;
  patchId: number;
  herdSize: number;
}

/**
 * Picks what to go after. A predator settles on a kind of prey in proportion to the square of
 * how many it can see: it finds what is plentiful and rarely comes across what is scarce, so a
 * prey that has grown rare is left alone to recover (a type III response). Within that kind it
 * picks off the most vulnerable — a tired, unwary animal first.
 */
export function choosePrey<T extends PreyCandidate>(candidates: readonly T[], rng: Rng): T {
  const bySpecies = new Map<string, T[]>();
  for (const candidate of candidates) {
    const list = bySpecies.get(candidate.agent.speciesId);
    if (list === undefined) bySpecies.set(candidate.agent.speciesId, [candidate]);
    else list.push(candidate);
  }

  const kinds = [...bySpecies.values()];
  const total = kinds.reduce((sum, list) => sum + list.length * list.length, 0);
  let pick = rng.next() * total;
  let chosen = kinds[kinds.length - 1]!;
  for (const list of kinds) {
    pick -= list.length * list.length;
    if (pick < 0) { chosen = list; break; }
  }

  const vulnerability = (candidate: T): number =>
    (1 - candidate.agent.drives.fatigue) * (1 - candidate.agent.drives.fear * 0.5);
  let best = chosen[0]!;
  for (const candidate of chosen) if (vulnerability(candidate) < vulnerability(best)) best = candidate;
  return best;
}
