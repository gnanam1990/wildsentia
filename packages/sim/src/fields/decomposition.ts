import {
  CARCASS_FRACTIONS, NUTRIENT_PER_KG_BIOMASS, carcassMass, edibleMass,
  type Carcass, type CarcassBiomass, type Confidence, type DeathCause, type DecayStage,
  type Patch, type Season, type WorldTime,
} from '@vana/shared';

/**
 * Fraction of remaining tissue that decays per hour under ideal conditions, by tissue type.
 * Soft tissue goes first; bone outlasts everything, which is why a patch keeps returning
 * nutrients for months after the animal died.
 */
const DECAY_PER_HOUR: Readonly<CarcassBiomass> = {
  muscle: 0.022,
  organ: 0.030,
  hide: 0.006,
  bone: 0.0032,
  ingesta: 0.030,
};

/** Warm and wet speeds decomposition; a dry-season carcass can persist for weeks. */
const SEASON_DECAY_FACTOR: Record<Season, number> = {
  monsoon: 1.5,
  wet: 1.2,
  transition: 0.7,
  dry: 0.35,
};

/**
 * sim_0.38.0: pathogen load gained per hour at a decay rate of one, from 0.1 at death. Bacteria
 * multiply as the carcass rots, so the load follows the same warmth and damp as decay: a monsoon
 * kill passes a jackal's tolerance (0.45) in three to four days and a tiger's (0.6) in four to five;
 * a dry-season one takes weeks. Before, it stayed at 0.1, so no carcass was ever too far gone.
 * Uncalibrated modelling choice, not a measured microbial growth rate.
 */
const PATHOGEN_PER_HOUR = 0.004;

const STAGE_THRESHOLDS: ReadonlyArray<{ stage: DecayStage; remaining: number }> = [
  { stage: 1, remaining: 0.92 },
  { stage: 2, remaining: 0.55 },
  { stage: 3, remaining: 0.34 },
  { stage: 4, remaining: 0.18 },
  { stage: 5, remaining: 0 },
];

export function makeCarcass(
  id: string,
  originId: string,
  speciesId: string,
  patchId: number,
  diedAt: WorldTime,
  cause: DeathCause,
  causeConfidence: Confidence,
  massKg: number,
): Carcass {
  return {
    id, originId, speciesId, patchId, diedAt, cause, causeConfidence,
    originalMassKg: massKg,
    biomass: {
      muscle: massKg * CARCASS_FRACTIONS.muscle,
      organ: massKg * CARCASS_FRACTIONS.organ,
      hide: massKg * CARCASS_FRACTIONS.hide,
      bone: massKg * CARCASS_FRACTIONS.bone,
    },
    decayStage: 1,
    pathogenLoad: 0.1,
    // Bigger bodies carry further. Scavengers use this to find it.
    scentRadiusM: 120 + Math.sqrt(massKg) * 45,
    consumers: [],
  };
}

export interface DecayResult {
  removedKg: number;
  stageChanged: boolean;
  stage: DecayStage;
}

/**
 * Advances decay and moves every gram it removes into the patch's soil nutrient pool.
 * Nothing is destroyed; the material cycle closes here.
 */
export function decayCarcass(
  carcass: Carcass,
  patch: Patch,
  hours: number,
  season: Season,
): DecayResult {
  // Fungi and bacteria work faster in warm, damp soil.
  const rate = SEASON_DECAY_FACTOR[season] * (0.35 + patch.soilMoisture * 0.65);
  let removed = 0;

  for (const tissue of ['muscle', 'organ', 'hide', 'bone', 'ingesta'] as const) {
    const present = carcass.biomass[tissue] ?? 0;
    if (present <= 0) continue;
    const loss = Math.min(present, present * DECAY_PER_HOUR[tissue]! * rate * hours);
    carcass.biomass[tissue] = present - loss;
    removed += loss;
  }

  patch.soilNutrients += removed * NUTRIENT_PER_KG_BIOMASS;
  carcass.pathogenLoad = Math.min(1, carcass.pathogenLoad + PATHOGEN_PER_HOUR * rate * hours);

  const fraction = carcassMass(carcass.biomass) / Math.max(carcass.originalMassKg, 1e-9);

  const previous = carcass.decayStage;
  let stage: DecayStage = 5;
  for (const threshold of STAGE_THRESHOLDS) {
    if (fraction > threshold.remaining) { stage = threshold.stage; break; }
  }
  // Decay never runs backwards, even if a scavenger's arithmetic nudges the fraction up.
  if (stage > previous) carcass.decayStage = stage;

  return { removedKg: removed, stageChanged: carcass.decayStage !== previous, stage: carcass.decayStage };
}

/** True once there is nothing left worth tracking. */
export function isSpent(carcass: Carcass): boolean {
  const threshold = Math.max(0.5, carcass.originalMassKg * 0.05);
  return carcass.decayStage === 5 && carcassMass(carcass.biomass) < threshold;
}

export { edibleMass };
