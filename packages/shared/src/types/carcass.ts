import type { PatchId } from './patch.js';
import type { WorldTime } from '../time.js';
import type { Confidence } from './event.js';

export type DeathCause =
  | 'predation' | 'starvation' | 'dehydration'
  /** Reached the species' maximum age. */
  | 'senescence'
  /** The background hazard of being alive at this life stage: disease, accident, bad luck. */
  | 'natural'
  /** A floater killed fighting for a range, or driven out and lost to the forest. */
  | 'territorial'
  | 'injury' | 'unknown';

export type DecayStage = 1 | 2 | 3 | 4 | 5;

export interface CarcassBiomass {
  /** Kilograms. Scavengers take muscle and organ first; bone outlasts everything. */
  muscle: number;
  organ: number;
  hide: number;
  bone: number;
}

export interface Carcass {
  id: string;
  originId: string;
  speciesId: string;
  patchId: PatchId;
  diedAt: WorldTime;
  /** Mass at death. Decay stages are a fraction of this, so it has to outlive the tissue. */
  originalMassKg: number;
  cause: DeathCause;
  causeConfidence: Confidence;
  biomass: CarcassBiomass;
  decayStage: DecayStage;
  /** 0-1. Drawn against a consumer's carrionTolerance. */
  pathogenLoad: number;
  scentRadiusM: number;
  consumers: Array<{ agentId: string; at: WorldTime; kg: number }>;
}

/** Proportions of a mammal carcass by mass. They sum to 1, which the nutrient ledger relies on. */
export const CARCASS_FRACTIONS: Readonly<CarcassBiomass> = {
  muscle: 0.45,
  organ: 0.12,
  hide: 0.15,
  bone: 0.28,
};

export function carcassMass(biomass: CarcassBiomass): number {
  return biomass.muscle + biomass.organ + biomass.hide + biomass.bone;
}

/** What a scavenger can actually eat. Bone is not food. */
export function edibleMass(biomass: CarcassBiomass): number {
  return biomass.muscle + biomass.organ;
}
