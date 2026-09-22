import {
  NUTRIENT_PER_KG_BIOMASS,
  type Agent, type Patch, type Rng, type SpeciesConfig, type WorldTime,
} from '@vana/shared';
import { WORLD_SECONDS_PER_DAY } from '@vana/shared';
import { inheritTraits } from './genetics.js';
import { canBreed, stageFor } from './lifecycle.js';
import type { Pedigree } from './pedigree.js';

/** Above this, a pairing is refused outright. 0.25 is a full sibling or a parent. */
export const MAX_ACCEPTABLE_RELATEDNESS = 0.25;

/** A female below this body condition does not conceive. Breeding costs more than she has. */
export const MIN_BREEDING_CONDITION = 0.35;

export function isReceptive(agent: Agent, config: SpeciesConfig, worldTime: WorldTime): boolean {
  if (!canBreed(agent, config)) return false;
  if (agent.pregnantSince !== null) return false;

  const condition = 1 - Math.max(agent.drives.hunger, agent.drives.thirst);
  if (condition < MIN_BREEDING_CONDITION) return false;

  if (agent.sex === 'female' && agent.lastBirthAt !== null) {
    const daysSince = (worldTime - agent.lastBirthAt) / WORLD_SECONDS_PER_DAY;
    if (daysSince < config.lifecycle.interBirthIntervalDays) return false;
  }
  return true;
}

export interface MateAssessment {
  candidate: Agent;
  score: number;
  relatedness: number;
}

/**
 * Scores a candidate on condition, size and how closely related it is. Returns null when the
 * pairing is too close — which is what makes dispersal worth anything.
 */
export function assessMate(
  chooser: Agent,
  candidate: Agent,
  pedigree: Pedigree,
): MateAssessment | null {
  if (chooser.sex === candidate.sex) return null;

  const relatedness = pedigree.relatedness(chooser.id, candidate.id);
  if (relatedness > MAX_ACCEPTABLE_RELATEDNESS) return null;

  const condition = 1 - Math.max(candidate.drives.hunger, candidate.drives.thirst);
  const score =
    condition * 0.5
    + candidate.traits.sizeTendency * 0.2
    + candidate.traits.diseaseResistance * 0.2
    + (1 - relatedness) * 0.1;

  return { candidate, score, relatedness };
}

/**
 * Courtship can fail, and failure is an ordinary outcome rather than an error.
 *
 * `localDensity` is how many of the same species share this animal's patch. Crowding suppresses
 * conception well before scarcity starves anyone — which is the density-dependent regulation the
 * spec asks for (§6.3), and the reason a population settles instead of overshooting and crashing.
 */
export function attemptCourtship(
  chooser: Agent,
  candidate: Agent,
  rng: Rng,
  localDensity = 1,
  crowdingThreshold = 6,
): boolean {
  const chooserCondition = 1 - Math.max(chooser.drives.hunger, chooser.drives.thirst);
  const candidateCondition = 1 - Math.max(candidate.drives.hunger, candidate.drives.thirst);
  const crowding = 1 / (1 + Math.max(0, localDensity - 1) / crowdingThreshold);
  const chance = (0.35 + chooserCondition * 0.25 + candidateCondition * 0.25) * crowding;
  return rng.bool(Math.min(0.92, chance));
}

export function conceive(mother: Agent, father: Agent, worldTime: WorldTime): void {
  mother.pregnantSince = worldTime;
  mother.targetId = father.id;
}

export function isReadyToGiveBirth(
  mother: Agent,
  config: SpeciesConfig,
  worldTime: WorldTime,
): boolean {
  if (mother.pregnantSince === null) return false;
  const days = (worldTime - mother.pregnantSince) / WORLD_SECONDS_PER_DAY;
  return days >= config.lifecycle.gestationDays;
}

export interface BirthResult {
  newborns: Agent[];
  /** Kilograms of new body mass, drawn from the patch's soil nutrient pool. */
  massDrawnKg: number;
}

/**
 * Produces a litter. Newborn mass is taken from the patch soil, standing for the food the
 * mother converted during gestation — which the feeding model has already returned there.
 * Nothing is created from nothing, so the nutrient ledger stays exact.
 */
export function birth(
  mother: Agent,
  father: Agent | null,
  config: SpeciesConfig,
  patch: Patch,
  pedigree: Pedigree,
  rng: Rng,
  worldTime: WorldTime,
  nextId: () => string,
): BirthResult {
  const [min, max] = config.lifecycle.litterSize;
  const wanted = min + rng.int(max - min + 1);

  const newbornMass = config.body.adultMassKg * config.lifecycle.stages[0]!.sizeFactor;
  const affordable = Math.floor(
    Math.max(0, patch.soilNutrients) / (newbornMass * NUTRIENT_PER_KG_BIOMASS),
  );
  const count = Math.min(wanted, affordable);

  const inbreeding = father === null ? 0 : pedigree.coefficientFor(mother.id, father.id);
  const newborns: Agent[] = [];

  for (let i = 0; i < count; i++) {
    const traits = father === null
      ? mother.traits
      : inheritTraits(mother.traits, father.traits, rng, inbreeding);

    const child: Agent = {
      id: nextId(),
      speciesId: mother.speciesId,
      bornAt: worldTime,
      massKg: newbornMass,
      patchId: mother.patchId,
      state: 'resting',
      currentGoal: 'rest',
      alternativeGoal: null,
      goalScore: 0,
      targetId: null,
      stamina: 1,
      sex: rng.bool(0.5) ? 'female' : 'male',
      ageDays: 0,
      lifeStage: stageFor(0, config),
      traits,
      motherId: mother.id,
      fatherId: father?.id ?? null,
      generation: Math.max(mother.generation, father?.generation ?? 0) + 1,
      dependentOn: mother.id,
      pregnantSince: null,
      lastBirthAt: null,
      offspringIds: [],
      drives: { hunger: 0.2, thirst: 0.2, fatigue: 0.1, fear: 0 },
      alive: true,
    };

    pedigree.record(child.id, mother.id, father?.id ?? null);
    mother.offspringIds.push(child.id);
    father?.offspringIds.push(child.id);
    newborns.push(child);
  }

  const massDrawnKg = count * newbornMass;
  patch.soilNutrients -= massDrawnKg * NUTRIENT_PER_KG_BIOMASS;

  mother.pregnantSince = null;
  mother.lastBirthAt = worldTime;
  mother.targetId = null;

  return { newborns, massDrawnKg };
}
