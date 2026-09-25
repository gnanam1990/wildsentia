import { edibleMass, positionInPatch, type Agent, type Carcass, type GoalId, type SpeciesConfig, type WorldTime } from '@vana/shared';
import { HUNGER_PER_DAY, THIRST_PER_DAY } from './drives.js';
import { stageConfig } from './lifecycle.js';
import type { WorldView } from './perception.js';
import { woundMobilityFactor } from './wound.js';

/** Deliberately simple model policy, not species-calibrated physiology. */
export function needsOf(agent: Agent, species: SpeciesConfig): { foodKg: number; waterL: number } {
  const massRatio = Math.max(0.01, agent.massKg / species.body.adultMassKg);
  const factor = massRatio ** 0.75;
  return { foodKg: species.diet.dailyIntakeKg * factor, waterL: species.diet.waterNeedLPerDay * factor };
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

/** Cub solid food is not independent hunting or a general carrion license. */
export const canEatMaternalMeat = (agent: Agent, species: SpeciesConfig): boolean =>
  species.id === 'tiger' && needsProvisioning(agent, species)
  && agent.ageDays >= (species.lifecycle.meatFromDays ?? species.lifecycle.weanDays);

/** A still-dependent tiger may only eat a finite carcass its living mother already opened.
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

/** Same patch is not contact. Missing/invalid legacy coordinates cannot authorize a transfer. */
export function inCareContact(parent: Agent, child: Agent, species: SpeciesConfig): boolean {
  return parent.patchId === child.patchId && positionInPatch(parent.position, parent.patchId)
    && positionInPatch(child.position, child.patchId)
    && Math.hypot(parent.position.x - child.position.x, parent.position.z - child.position.z) <= careRadius(species) + 1e-8;
}

/** Losing a parent does not confer adult hunting ability. */
export function canHuntIndependently(agent: Agent, species: SpeciesConfig): boolean {
  return !needsProvisioning(agent, species) && !stageConfig(agent.lifeStage, species).dependent;
}

/** Young legs are not adult legs; adult speed remains the configured value. */
export function locomotionFactor(agent: Agent, species: SpeciesConfig): number {
  return Math.sqrt(Math.min(1, Math.max(0.01, agent.massKg / species.body.adultMassKg))) * woundMobilityFactor(agent);
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
export function provisionYoung(parent: Agent, child: Agent, species: SpeciesConfig, hours: number,
  remaining?: { foodDays: number; waterDays: number }, at?: WorldTime): {
  foodEquivalentKg: number; waterEquivalentL: number;
} {
  const none = { foodEquivalentKg: 0, waterEquivalentL: 0 };
  if (!parent.alive || !child.alive || parent.id === child.id || child.dependentOn !== parent.id
    || parent.speciesId !== child.speciesId || !inCareContact(parent, child, species)
    || !needsProvisioning(child, species) || !Number.isFinite(hours) || !(hours > 0)) return none;
  if (remaining && [remaining.foodDays, remaining.waterDays].some(v => !Number.isFinite(v) || v < 0)) return none;
  const source = needsOf(parent, species), target = needsOf(child, species);
  const contactHoursPerDay = (species.lifecycle.nursing?.dailyContactSeconds ?? 8 * 3600) / 3600;
  const food = Math.min(child.drives.hunger / HUNGER_PER_DAY * target.foodKg,
    target.foodKg * hours / contactHoursPerDay, target.foodKg * (remaining?.foodDays ?? Infinity),
    Math.max(0, 0.8 - parent.drives.hunger) / HUNGER_PER_DAY * source.foodKg);
  const boarCap = boarMaternalWaterCap(child, species, hours, at, target.waterL);
  const water = Math.min(child.drives.thirst / THIRST_PER_DAY * target.waterL,
    boarCap ?? target.waterL * hours / contactHoursPerDay, target.waterL * (remaining?.waterDays ?? Infinity),
    Math.max(0, 0.8 - parent.drives.thirst) / THIRST_PER_DAY * source.waterL);
  child.drives.hunger = Math.max(0, child.drives.hunger - food / target.foodKg * HUNGER_PER_DAY);
  child.drives.thirst = Math.max(0, child.drives.thirst - water / target.waterL * THIRST_PER_DAY);
  parent.drives.hunger += food / source.foodKg * HUNGER_PER_DAY;
  parent.drives.thirst += water / source.waterL * THIRST_PER_DAY;
  return { foodEquivalentKg: food, waterEquivalentL: water };
}
