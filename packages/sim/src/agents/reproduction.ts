import {
  NUTRIENT_PER_KG_BIOMASS,
  type Agent, type Patch, type Rng, type SpeciesConfig, type Traits, type WorldTime,
} from '@vana/shared';
import { WORLD_SECONDS_PER_DAY } from '@vana/shared';
import { inheritTraits } from './genetics.js';
import { canBreed, stageFor } from './lifecycle.js';
import type { Pedigree } from './pedigree.js';
import { breedingFertility } from './needs.js';

/** Above this, a pairing is refused outright. 0.25 is a full sibling or a parent. */
export const MAX_ACCEPTABLE_RELATEDNESS = 0.25;

/** A female below this body condition does not conceive. Breeding costs more than she has. */
export const MIN_BREEDING_CONDITION = 0.35;

export function isReceptive(agent: Agent, config: SpeciesConfig, worldTime: WorldTime): boolean {
  if (!canBreed(agent, config)) return false;
  if (agent.pregnantSince !== null) return false;

  const condition = 1 - Math.max(agent.drives.hunger, agent.drives.thirst);
  if (condition < MIN_BREEDING_CONDITION) return false;
  // sim_0.37.0: a female in poor body condition over the past weeks does not come into breeding
  // (wild boar; Servanty et al. 2009), however well she ate today.
  if (agent.sex === 'female' && breedingFertility(agent, config) <= 0) return false;

  if (agent.sex === 'female' && agent.nextOestrusAt != null && worldTime < agent.nextOestrusAt) {
    return false;
  }

  // The inter-birth interval runs birth to birth, as field studies report it, so she can
  // conceive once what is left of it is no longer than a gestation.
  if (agent.sex === 'female' && agent.lastBirthAt !== null) {
    const daysSince = (worldTime - agent.lastBirthAt) / WORLD_SECONDS_PER_DAY;
    const { interBirthIntervalDays, gestationDays } = config.lifecycle;
    if (daysSince < interBirthIntervalDays - gestationDays) return false;
  }
  return true;
}

/**
 * A pack raises one litter at a time, the dominant female's; the others help feed it. Without
 * this every female in a pack bred at once, and twelve dholes became fifty-six in four months
 * before most of them starved. Herds, troops and pairs are not affected.
 */
export function packAllowsBreeding(
  female: Agent,
  config: SpeciesConfig,
  packmates: readonly Agent[],
  hasDependants: (agent: Agent) => boolean,
): boolean {
  if (config.social.structure !== 'pack') return true;
  for (const other of packmates) {
    if (other.id === female.id || !other.alive || other.sex !== 'female') continue;
    if (other.pregnantSince !== null || hasDependants(other)) return false;
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
 * sim_0.38.0: the count includes the pair, so only the others crowd them; the mate in contact
 * was counted as a crowd of one, cutting a lone pair's chance by a seventh.
 */
export function attemptCourtship(
  chooser: Agent,
  candidate: Agent,
  rng: Rng,
  localDensity = 2,
  crowdingThreshold = 6,
  fertility = 1,
): boolean {
  const chooserCondition = 1 - Math.max(chooser.drives.hunger, chooser.drives.thirst);
  const candidateCondition = 1 - Math.max(candidate.drives.hunger, candidate.drives.thirst);
  const crowding = 1 / (1 + Math.max(0, localDensity - 2) / crowdingThreshold);
  // sim_0.37.0: `fertility` (0-1) is the female's breeding readiness from body condition.
  const chance = (0.35 + chooserCondition * 0.25 + candidateCondition * 0.25) * crowding * fertility;
  return rng.bool(Math.min(0.92, chance));
}

/**
 * A courtship that fails ends this oestrus. Without this a female simply tried again the next
 * hour, so crowding delayed conception by a day or two in a cycle of months and never slowed a
 * population at all. Crowding now costs her whole cycles, which is how it works in the field.
 */
export function endOestrus(female: Agent, config: SpeciesConfig, worldTime: WorldTime): void {
  female.nextOestrusAt = worldTime + config.lifecycle.oestrusCycleDays * WORLD_SECONDS_PER_DAY;
}

export function conceive(mother: Agent, father: Agent, worldTime: WorldTime): void {
  mother.pregnantSince = worldTime;
  mother.pregnancyFatherId = father.id;
}

/**
 * A founding female's place in her breeding cycle (Congo founders). A wild population holds its
 * females at every point of the cycle, so she is drawn uniformly over one inter-birth interval:
 * within a gestation of her next birth she is already pregnant, that far along (by a sire from
 * before the record, so none is named); otherwise she comes into breeding when her interval allows.
 * Her young from the last birth are not founded with her.
 */
export function foundingBreedingState(config: SpeciesConfig, draw: number, worldTime: WorldTime):
  { pregnantSince: number | null; pregnancyFatherId?: null; nextOestrusAt?: number } {
  const { interBirthIntervalDays: interval, gestationDays: gestation } = config.lifecycle;
  const sinceBirth = draw * interval, open = interval - gestation;
  return sinceBirth < open
    ? { pregnantSince: null, nextOestrusAt: worldTime + (open - sinceBirth) * WORLD_SECONDS_PER_DAY }
    : { pregnantSince: worldTime - (sinceBirth - open) * WORLD_SECONDS_PER_DAY, pregnancyFatherId: null };
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
  /** A sire from outside the record (a Congo founder's mate): the young inherit from him too. */
  outsideSire?: Traits,
): BirthResult {
  const [fullMin, fullMax] = config.lifecycle.litterSize;
  // sim_0.37.0: a mother in poor condition carries a smaller litter (wild boar litter size rises
  // with the sow's body mass, about one piglet per 16 kg: Bergqvist et al. 2018; Servanty et al.
  // 2009). The configured range is the litter at full condition; at the least condition in which
  // she still breeds both ends are halved.
  const scale = config.lifecycle.condition ? 0.5 + 0.5 * breedingFertility(mother, config) : 1;
  const min = Math.max(1, Math.round(fullMin * scale)), max = Math.max(min, Math.round(fullMax * scale));
  const wanted = min + rng.int(max - min + 1);

  const newbornMass = config.body.adultMassKg * config.lifecycle.stages[0]!.sizeFactor;
  const affordable = Math.floor(
    Math.max(0, patch.soilNutrients) / (newbornMass * NUTRIENT_PER_KG_BIOMASS),
  );
  const count = Math.min(wanted, affordable);

  const inbreeding = father === null ? 0 : pedigree.coefficientFor(mother.id, father.id);
  const newborns: Agent[] = [];

  for (let i = 0; i < count; i++) {
    const traits = father !== null ? inheritTraits(mother.traits, father.traits, rng, inbreeding)
      : outsideSire ? inheritTraits(mother.traits, outsideSire, rng) : mother.traits;

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
  mother.pregnancyFatherId = null;
  mother.lastBirthAt = worldTime;
  mother.targetId = null;

  return { newborns, massDrawnKg };
}
