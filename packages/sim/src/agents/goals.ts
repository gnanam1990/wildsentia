import { type Agent, type GoalId, type Rng, type SpeciesConfig } from '@vana/shared';
import { edibleMass } from '../fields/decomposition.js';
import { goalsFor } from './archetypes.js';
import type { Percept } from './perception.js';
import { isCarried, allowsDependentGoal, canDrinkIndependently, canFollowParent, canEatMaternalMeat, canForageIndependently, canHuntIndependently, needsOf, needsProvisioning } from './needs.js';

export interface GoalChoice {
  goal: GoalId;
  score: number;
  alternative: GoalId | null;
}

const NOISE = 0.05;
// A mobile, pre-foraging dependent stays at a care rendezvous while already hydrated.
// Otherwise noise can make water its only active goal at thirst ~0, repeatedly pulling it
// away from nursing contact. This is a decision threshold, not a drinking-age claim.
const DEPENDENT_WATER_SEARCH_THIRST = 0.2;

/**
 * sim_0.37.0: how active a species is at this hour of the day, 0-1 (`activity.hourly`, from field
 * activity curves). Species without a curve are active at every hour.
 */
export function activityAt(species: SpeciesConfig, worldTime: number | undefined): number {
  const hourly = species.activity?.hourly;
  if (!hourly || worldTime === undefined || !Number.isFinite(worldTime)) return 1;
  const hour = Math.floor((((worldTime % 86400) + 86400) % 86400) / 3600);
  return hourly[hour] ?? 1;
}

/** Hunger at which an animal hunts at any hour: the desperation at which need outranks fear. */
const ACTIVITY_OVERRIDE_HUNGER = 0.8;

/**
 * utility = drive x opportunity, plus bounded noise so identical animals diverge.
 *
 * Only the goals the archetype allows are scored, so what an animal can want is decided by its
 * species config rather than by a branch on its id.
 */
export function selectGoal(
  agent: Agent,
  species: SpeciesConfig,
  percept: Percept,
  rng: Rng,
  litterHunger = 0,
  worldTime?: number,
): GoalChoice {
  const d = agent.drives;
  // sim_0.37.0: a cat mother hunts for her cubs as well as herself. Her own stomach cannot feed
  // weaned cubs that cannot yet hunt (cats do not regurgitate), so she hunts when they are hungry
  // even while she is sated. On the island a leopardess, full from her own kills, never hunted
  // again before her three 95-day-old cubs starved beside her.
  const threshold = species.hunting?.huntFromHunger ?? 0;
  const forLitter = litterHunger >= threshold && litterHunger > d.hunger;
  const huntHunger = forLitter ? litterHunger : d.hunger;
  const stamina = agent.stamina ?? 1;

  // Opportunity is measured against what this animal actually needs, not against a fixed
  // number of kilograms. A carcass that is a week's food for a vulture is a snack for a tiger,
  // and scoring both against the same threshold left the vulture wandering past its dinner.
  const needs = needsOf(agent, species);
  const dailyNeed = Math.max(needs.foodKg, 0.05);
  const waterNeed = Math.max(needs.waterL, 0.05);

  const foodOpportunity = percept.bestFood
    ? Math.min(1, percept.bestFood.kg / (dailyNeed * 8)) : 0.05;
  const waterOpportunity = percept.bestWater
    ? Math.min(1, percept.bestWater.litres / (waterNeed * 8)) : 0.05;
  // sim_0.37.0: a hunter that knows where prey of its size graze (range memory) has a reason to
  // go hunting even with none in sight.
  const preyOpportunity = Math.max(percept.prey.length > 0 ? Math.min(1, percept.prey.length / 3) : 0,
    percept.preyRange != null ? 0.5 : 0);
  const carrionOpportunity = percept.carrion
    ? Math.min(1, edibleMass(percept.carrion.carcass.biomass) / (dailyNeed * 2))
    : 0;

  // Desperation. Past these thresholds the need outranks fear, because an animal that never
  // drinks dies just as surely as one that is caught.
  const thirstDesperation = Math.max(0, d.thirst - 0.72) * 6;
  const hungerDesperation = Math.max(0, d.hunger - 0.80) * 4;

  // sim_0.37.0 daily activity: outside its active hours an animal that is not desperate starts no
  // hunt and does not range; it rests. Dholes hunt by day and tigers and leopards by night
  // (activity.hourly). A dhole pack hunting round a hare's form at 20:00-22:00 two nights running
  // kept the doe from her once-daily evening feed until the leverets died.
  const active = activityAt(species, worldTime);
  const huntActive = huntHunger >= ACTIVITY_OVERRIDE_HUNGER ? 1 : active;

  const all: Record<GoalId, number> = {
    // Linear in the drive, not squared. Now that eating a ration only offsets a day's hunger,
    // an animal has to spend most of its time feeding to stay fed — and a squared term left a
    // grazer at thirty percent hunger preferring to wander, then starving in a field of grass.
    find_food: d.hunger * (0.3 + foodOpportunity) + hungerDesperation,
    find_water: d.thirst * (0.3 + waterOpportunity) + thirstDesperation,
    rest: d.fatigue * d.fatigue * (1 - d.hunger * 0.5) * (1 - d.thirst * 0.5) + (1 - active) * 0.15,
    wander: (0.08 + (1 - d.hunger) * (1 - d.thirst) * 0.05) * active,
    // A hunt is only worth starting with prey in sight and the legs to chase it — and never
    // while there is still meat on something already dead nearby. Without this a predator
    // abandoned a carcass it had barely touched and killed again, so the world lost five
    // animals for every one a predator actually ate.
    // A predator with meat still in its stomach is sated and does not start a hunt
    // (sim_0.35.0): its attempt rate follows its intake, not an hourly retry on any hunger.
    hunt: carrionOpportunity > 0.3 || (agent.gutKg ?? 0) > 0 && !forLitter || huntHunger < threshold
      ? 0 : huntHunger * preyOpportunity * stamina * huntActive,
    // Carrion is cheaper than a hunt, so a hungry scavenger prefers it strongly.
    scavenge: d.hunger * carrionOpportunity * 1.35,
    // Fear outranks ordinary needs but not desperate ones, and an exhausted animal cannot
    // keep running however frightened it is.
    flee: d.fear * d.fear * 1.8 * (0.35 + stamina * 0.65),
    // Breeding is handled by the world before goals are scored, because it needs a partner
    // and the pedigree. This entry exists so the record is complete.
    breed: 0,
    // Family coordination uses start-of-decision targets in the world, not noisy archetype scoring.
    care_for_young: 0,
    follow_parent: 0,
    seek_nursing: 0,
    collect_pack_food: 0, deliver_pack_food: 0, wait_for_pack_food: 0,
  };

  // sim_0.34.0: young too small to follow their parent are hiders. Fawns, piglets in the nest
  // and pups in the den lie still when danger is near rather than run (the hider strategy);
  // with prey now sensing predators hundreds of metres off, fleeing scattered whole litters
  // where their mother could not reach them and they died of thirst.
  // sim_0.37.0: a carried infant clings to its mother rather than run on its own; she carries it.
  const hider = needsProvisioning(agent, species) && (!canFollowParent(agent, species) || isCarried(agent, species));

  // Orphanhood never unlocks abilities. Precocial plant foraging has a separate age gate.
  if (needsProvisioning(agent, species) && !canForageIndependently(agent, species)
    && !canDrinkIndependently(agent, species) && !canEatMaternalMeat(agent, species)) {
    // sim_0.36.0: a young old enough to follow moves off once frightened (fear 0.5, the level at
    // which its mother and every family routine break off), not only above it. A three-month-old
    // chital fawn lay two days beside a resting tiger, its mother scared off every other hour,
    // and died of thirst at 358 m from her with water in its own patch.
    return { goal: !hider && d.fear >= 0.5 && percept.threat !== null ? 'flee' : 'rest', score: 1, alternative: null };
  }

  // sim_0.37.0: a predator that is itself hunted (a leopard that detects a tiger) can flee, as
  // prey do. Archetypes without flight gain it only while such a threat is detected, so a tiger
  // or dhole, which nothing hunts, scores exactly the goals it always did.
  const archetypeGoals = goalsFor(species.archetype);
  const goals = percept.threat !== null && !archetypeGoals.includes('flee') ? [...archetypeGoals, 'flee' as const] : archetypeGoals;
  const allowed = goals
    .filter((goal) => allowsDependentGoal(agent, species, goal))
    .filter((goal) => goal !== 'find_water' || !needsProvisioning(agent, species)
      || canForageIndependently(agent, species) || d.thirst >= DEPENDENT_WATER_SEARCH_THIRST)
    .filter((goal) => goal !== 'flee' || !needsProvisioning(agent, species)
      || !hider && (canForageIndependently(agent, species) || percept.threat !== null || d.fear >= 0.5))
    .filter((goal) => goal !== 'hunt' || canHuntIndependently(agent, species))
    .filter((goal) => goal !== 'scavenge' || !needsProvisioning(agent, species)
      || percept.carrion !== null);
  const ranked = allowed
    .map((goal) => ({ goal, score: all[goal] + rng.next() * NOISE }))
    .sort((a, b) => b.score - a.score);

  const winner = ranked[0]!;
  return { goal: winner.goal, score: winner.score, alternative: ranked[1]?.goal ?? null };
}
