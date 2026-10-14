import { edibleMass, positionInPatch, type Agent, type Carcass, type GoalId, type SpeciesConfig, type WorldTime, type WorldGrid } from '@vana/shared';
import { HUNGER_PER_DAY, THIRST_PER_DAY } from './drives.js';
import { adultMassFor, stageConfig } from './lifecycle.js';
import type { WorldView } from './perception.js';
import { woundMobilityFactor } from './wound.js';

/** Deliberately simple model policy, not species-calibrated physiology. */
export function needsOf(agent: Agent, species: SpeciesConfig): { foodKg: number; waterL: number } {
  const massRatio = Math.max(0.01, agent.massKg / species.body.adultMassKg);
  const factor = massRatio ** 0.75;
  return { foodKg: species.diet.dailyIntakeKg * factor, waterL: species.diet.waterNeedLPerDay * factor };
}

/**
 * sim_0.35.0 satiety. A tiger eats 18-35 kg at a sitting and then needs no kill for days; a model
 * whose hunger stopped at zero threw the rest away, so a predator ate a day's food from each
 * kill and killed again. Meat beyond the day's hunger now fills the stomach up to this capacity.
 */
export function gutCapacityKg(agent: Agent, species: SpeciesConfig): number {
  const fraction = species.diet.gutCapacityBodyFraction;
  return fraction ? agent.massKg * fraction : 0;
}

/** Digest stored meat as fast as the hour adds hunger. Food from beyond the roster
 * (`diet.offRosterShare`) feeds the rest of the day: digesting a whole day's intake from the
 * stomach threw away a golden cat's (0.6) meal 2.5 times too fast, and it killed again sooner. */
export function digestGut(agent: Agent, species: SpeciesConfig, hours: number): void {
  if (!(agent.gutKg! > 0)) { delete agent.gutKg; return; }
  const daily = needsOf(agent, species).foodKg;
  const kg = Math.min(agent.gutKg!, daily * (1 - (species.diet.offRosterShare ?? 0)) * hours / 24);
  agent.drives.hunger = Math.max(0, agent.drives.hunger - kg / daily * HUNGER_PER_DAY);
  agent.gutKg = agent.gutKg! - kg;
  if (!(agent.gutKg > 1e-9)) delete agent.gutKg;
}

/** Credit a meal: first to hunger, then to the stomach up to capacity. Returns the kg it can take. */
export function mealRoom(agent: Agent, species: SpeciesConfig): number {
  const daily = needsOf(agent, species).foodKg;
  return agent.drives.hunger / HUNGER_PER_DAY * daily + Math.max(0, gutCapacityKg(agent, species) - (agent.gutKg ?? 0));
}

export function creditMeal(agent: Agent, species: SpeciesConfig, eatenKg: number): void {
  const daily = needsOf(agent, species).foodKg;
  const toHunger = Math.min(eatenKg, agent.drives.hunger / HUNGER_PER_DAY * daily);
  agent.drives.hunger = Math.max(0, agent.drives.hunger - toHunger / daily * HUNGER_PER_DAY);
  const stored = Math.min(eatenKg - toHunger, Math.max(0, gutCapacityKg(agent, species) - (agent.gutKg ?? 0)));
  if (stored > 0) agent.gutKg = (agent.gutKg ?? 0) + stored;
}

export function needsProvisioning(agent: Agent, species: SpeciesConfig): boolean {
  return agent.ageDays < species.lifecycle.weanDays;
}

/** Supplementary plant foraging can precede weaning; it does not grant hunting or adult travel. */
export const canForageIndependently = (agent: Agent, species: SpeciesConfig): boolean =>
  agent.ageDays >= (species.lifecycle.forageFromDays ?? species.lifecycle.weanDays);

/** Drinking may precede solid-food foraging; it still requires actual route and water contact. */
export const canDrinkIndependently = (agent: Agent, species: SpeciesConfig): boolean =>
  agent.ageDays >= (species.lifecycle.drinkFromDays ?? species.lifecycle.forageFromDays ?? species.lifecycle.weanDays);

/** Cub solid food is not independent hunting or a general carrion license. Cats whose cubs eat
 * at their mother's kills before weaning set `meatFromDays` (tiger; sim_0.37.0 leopard). */
export const canEatMaternalMeat = (agent: Agent, species: SpeciesConfig): boolean =>
  species.hunting !== undefined && species.lifecycle.meatFromDays !== undefined && needsProvisioning(agent, species)
  && agent.ageDays >= (species.lifecycle.meatFromDays ?? species.lifecycle.weanDays);

/** A still-dependent cub may only eat a finite carcass its living mother already opened.
 * Perception may omit `at`; the action supplies decision time to reject a same-tick future meal.
 * The bounded scan is for simple test views; production supplies an O(1) `agentById` hook. */
export function canEatMaternalCarcass(agent: Agent, species: SpeciesConfig, carcass: Carcass,
  view: WorldView, at = Infinity): boolean {
  if (!canEatMaternalMeat(agent, species) || !agent.motherId || agent.dependentOn !== agent.motherId
    || edibleMass(carcass.biomass) <= 0
    || !view.carcassesInPatch(carcass.patchId).includes(carcass)) return false;
  const mother = view.agentById
    ? view.agentById(agent.motherId)
    : view.patches.reduce<Agent | undefined>((found, patch) => found ?? view.agentsInPatch(patch.id)
      .find(candidate => candidate.id === agent.motherId), undefined);
  return !!mother?.alive && mother.speciesId === agent.speciesId && mother.sex === 'female'
    && carcass.consumers.some(consumer => consumer.agentId === mother.id
      && consumer.kg > 0 && consumer.at <= at);
}

export function allowsDependentGoal(agent: Agent, species: SpeciesConfig, goal: GoalId): boolean {
  return !needsProvisioning(agent, species) || goal === 'rest' || goal === 'flee'
    || goal === 'find_food' && canForageIndependently(agent, species)
    || goal === 'find_water' && canDrinkIndependently(agent, species)
    || goal === 'scavenge' && canEatMaternalMeat(agent, species);
}

export const careRadius = (species: SpeciesConfig): number => 0.5 + species.body.shoulderHeightM * 0.75;
export const canFollowParent = (agent: Agent, species: SpeciesConfig): boolean =>
  agent.ageDays >= (species.lifecycle.followFromDays ?? species.lifecycle.weanDays);

/**
 * sim_0.36.0: a dependent this old walks to its parent's care point within its senses (the
 * litter gathers to suckle or to be fed), before it can follow her on the move.
 */
export const canGatherToParent = (agent: Agent, species: SpeciesConfig): boolean =>
  species.lifecycle.gatherFromDays !== undefined && agent.ageDays >= species.lifecycle.gatherFromDays;

/** sim_0.37.0: a dependent young enough to cling to its mother and be carried (langur infants). */
export const isCarried = (agent: Agent, species: SpeciesConfig): boolean =>
  species.lifecycle.carriedUntilDays !== undefined && agent.dependentOn !== null
  && agent.ageDays < species.lifecycle.carriedUntilDays;

/**
 * sim_0.36.0: a denned young below its gathering age cannot yet walk (jackal pups open their eyes
 * at about ten days). Attacked, it cannot run: a failed attack leaves it where it lies, instead
 * of scattering a litter of six-day-old pups 15-30 m apart where their mother could reach one
 * spot an hour.
 */
export const cannotYetWalk = (agent: Agent, species: SpeciesConfig): boolean =>
  species.lifecycle.gatherFromDays !== undefined && agent.ageDays < species.lifecycle.gatherFromDays;

/** Same patch is not contact. Missing/invalid legacy coordinates cannot authorize a transfer. */
export function inCareContact(grid: WorldGrid, parent: Agent, child: Agent, species: SpeciesConfig): boolean {
  return parent.patchId === child.patchId && positionInPatch(grid, parent.position, parent.patchId)
    && positionInPatch(grid, child.position, child.patchId)
    && Math.hypot(parent.position.x - child.position.x, parent.position.z - child.position.z) <= careRadius(species) + 1e-8;
}

/** Losing a parent does not confer adult hunting ability. */
export function canHuntIndependently(agent: Agent, species: SpeciesConfig): boolean {
  return !needsProvisioning(agent, species) && !stageConfig(agent.lifeStage, species).dependent;
}

/** Young legs are not adult legs; adult speed remains the configured value. Measured against the
 * adult mass of the animal's own sex (sim_0.37.0), so a full-grown leopardess runs at full speed. */
export function locomotionFactor(agent: Agent, species: SpeciesConfig): number {
  return Math.sqrt(Math.min(1, Math.max(0.01, agent.massKg / adultMassFor(agent, species)))) * woundMobilityFactor(agent);
}

/** The hourly engine cannot resolve individual milk-ejection bouts. For boar piglets still
 * below independent drinking age, a real care visit can replace only hydration accrued since
 * its previous successful visit. The eight-hour ceiling prevents one visit from clearing a
 * whole absent day; one minute is a conservative completed-contact guard, not a field rate. */
export function boarMaternalWaterCap(child: Agent, species: SpeciesConfig,
  contactHours: number, at: WorldTime | undefined, dailyWaterL: number): number | null {
  if (species.id !== 'boar' || child.ageDays >= (species.lifecycle.drinkFromDays ?? species.lifecycle.weanDays)) return null;
  if (!Number.isFinite(contactHours) || contactHours * 3600 < 60 || at === undefined
    || !Number.isFinite(at) || !Number.isFinite(dailyWaterL) || !(dailyWaterL > 0)) return 0;
  const previous = child.lastMaternalWaterAt ?? child.bornAt;
  if (!Number.isFinite(previous) || at <= previous) return 0;
  return dailyWaterL * Math.min(8 * 3600, at - previous) / 86400;
}

/**
 * Transfer abstract food-energy/water equivalents, never new carcass/soil biomass. The donor
 * must later replace these reserves through normal feeding/drinking. No free drive reset.
 * This is generic parental provisioning (also used for birds), not a milk chemistry model.
 * Per-visit capacity and donor safety margins are explicit, uncalibrated model policies.
 */
export function provisionYoung(grid: WorldGrid, parent: Agent, child: Agent, species: SpeciesConfig, hours: number,
  remaining?: { foodDays: number; waterDays: number }, at?: WorldTime): {
  foodEquivalentKg: number; waterEquivalentL: number;
} {
  const none = { foodEquivalentKg: 0, waterEquivalentL: 0 };
  if (!parent.alive || !child.alive || parent.id === child.id || child.dependentOn !== parent.id
    || parent.speciesId !== child.speciesId || !inCareContact(grid, parent, child, species)
    || !needsProvisioning(child, species) || !Number.isFinite(hours) || !(hours > 0)) return none;
  if (remaining && [remaining.foodDays, remaining.waterDays].some(v => !Number.isFinite(v) || v < 0)) return none;
  const source = needsOf(parent, species), target = needsOf(child, species);
  // sim_0.36.0: a once-daily feed (hares) is taken to repletion: its few minutes can replace the
  // whole deficit a young can carry (1 / THIRST_PER_DAY = 2.5 days), bounded by that deficit and
  // the mother's own reserves, not by one day's ration. Capped at a day, a leveret nursed at
  // thirst 0.9 left at 0.5 and lived permanently one missed feed from death: island traces found
  // whole litters dying the night after a doe fled a dhole once.
  const contactHoursPerDay = species.lifecycle.nursing
    ? species.lifecycle.nursing.dailyContactSeconds / 3600 * THIRST_PER_DAY : 8;
  const food = Math.min(child.drives.hunger / HUNGER_PER_DAY * target.foodKg,
    target.foodKg * hours / contactHoursPerDay, target.foodKg * (remaining?.foodDays ?? Infinity),
    Math.max(0, 0.8 - parent.drives.hunger) / HUNGER_PER_DAY * source.foodKg);
  const boarCap = boarMaternalWaterCap(child, species, hours, at, target.waterL);
  const water = Math.min(child.drives.thirst / THIRST_PER_DAY * target.waterL,
    boarCap ?? target.waterL * hours / contactHoursPerDay,
    target.waterL * (remaining?.waterDays ?? Infinity),
    Math.max(0, 0.8 - parent.drives.thirst) / THIRST_PER_DAY * source.waterL);
  child.drives.hunger = Math.max(0, child.drives.hunger - food / target.foodKg * HUNGER_PER_DAY);
  child.drives.thirst = Math.max(0, child.drives.thirst - water / target.waterL * THIRST_PER_DAY);
  parent.drives.hunger += food / source.foodKg * HUNGER_PER_DAY;
  parent.drives.thirst += water / source.waterL * THIRST_PER_DAY;
  return { foodEquivalentKg: food, waterEquivalentL: water };
}

/**
 * sim_0.37.0 body condition, for species whose reproduction tracks food (lifecycle.condition): a
 * running mean, over `conditionDays`, of the share of each day's food need met by the natural,
 * energy-rich diet (wild boar: rooting and mast food). Mast and seed crops, not the green forage
 * that keeps pigs alive, drive sows' body mass and fertility (Servanty et al. 2009; Gamelon et al.
 * 2017). Once a day, at the first hour of a new world day, the previous day's tally is folded in
 * (a day without feeding counts as none) and a new tally starts. Condition starts full.
 */
export function updateCondition(agent: Agent, species: SpeciesConfig, today: number): void {
  const policy = species.lifecycle.condition;
  if (!policy) return;
  const tally = agent.gutFill;
  if (tally === undefined) { agent.gutFill = { day: today, kg: 0, naturalKg: 0 }; return; }
  if (tally.day >= today) return;
  const need = needsOf(agent, species).foodKg;
  let condition = agent.condition ?? 1;
  const days = Math.min(today - tally.day, Math.ceil(policy.conditionDays * 3));
  for (let d = 0; d < days; d++) {
    const quality = d === 0 ? Math.min(1, tally.naturalKg / need) : 0;
    condition += (quality - condition) / policy.conditionDays;
  }
  agent.condition = Math.min(1, Math.max(0, condition));
  agent.gutFill = { day: today, kg: 0, naturalKg: 0 };
}

/**
 * 0-1: how fully body condition allows breeding (sim_0.37.0). Wild boar breed and carry large
 * litters in good condition and fail to breed, or carry small litters, in poor condition (Bieber
 * & Ruf 2005; Servanty et al. 2009). 1 for species without a condition policy.
 */
export function breedingFertility(agent: Agent, species: SpeciesConfig): number {
  const policy = species.lifecycle.condition;
  if (!policy) return 1;
  const condition = agent.condition ?? 1;
  return Math.min(1, Math.max(0, (condition - policy.minBreedingCondition)
    / (policy.fullBreedingCondition - policy.minBreedingCondition)));
}
