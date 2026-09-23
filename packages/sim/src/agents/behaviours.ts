import {
  NUTRIENT_PER_KG_BIOMASS, edibleMass,
  type Agent, type Carcass, type DeathCause, type Patch, type Rng,
  type SpeciesConfig, type WorldTime,
} from '@vana/shared';
import { HUNGER_PER_DAY, THIRST_PER_DAY } from './drives.js';
import type { EventLog } from '../events/log.js';
import { choosePrey, resolveHunt } from './predation.js';
import type { GoalChoice } from './goals.js';
import type { Percept, WorldView } from './perception.js';

/** The only writes a behaviour may make outside its own agent and patch. */
export interface WorldServices {
  kill(victim: Agent, cause: DeathCause, killerId: string | null): Carcass;
  removeCarcassIfSpent(carcass: Carcass): void;
}

export interface BehaviourContext {
  agent: Agent;
  species: SpeciesConfig;
  patches: Patch[];
  view: WorldView;
  percept: Percept;
  choice: GoalChoice;
  hours: number;
  worldTime: WorldTime;
  log: EventLog;
  rng: Rng;
  services: WorldServices;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Hours a day an animal actually spends feeding. `dailyIntakeKg` is a day's food, and dividing
 * it across all twenty-four hours implied an animal that grazes around the clock — so anything
 * that also rested, drank or fled fell behind and starved. A grazer feeds something like eight
 * hours a day; the ration is its share of that.
 */
const FORAGING_HOURS_PER_DAY = 8;
/** Drinking is quick. An animal takes its day's water in a couple of visits. */
const DRINKING_HOURS_PER_DAY = 3;

/**
 * How much a hungry animal will take above its even ration, and the gut capacity that limits it.
 *
 * Animals do not eat at a constant trickle: a tiger clears twenty kilograms off a kill in an
 * afternoon and then does not hunt for days. Capping intake near the even ration left predators
 * permanently hungry and attempting roughly five hunts a day each, which killed five animals for
 * every one they ate.
 *
 * Total daily intake is unchanged — hunger falls in proportion to `eaten / dailyIntakeKg`, so
 * eating faster only means eating sooner, never eating more.
 */
const GORGE_MULTIPLIER = 8;
const GUT_FRACTION_PER_HOUR = 0.05;

function appetite(rationKg: number, hunger: number, massKg: number, hours: number): number {
  return Math.min(
    rationKg * (1 + hunger * GORGE_MULTIPLIER),
    massKg * GUT_FRACTION_PER_HOUR * hours,
  );
}

function emit(
  ctx: BehaviourContext,
  type: Parameters<EventLog['append']>[0]['type'],
  patchId: number,
  actors: string[],
  conditions: Record<string, number | string>,
  outcome: 'success' | 'failure' | 'abandoned' | 'interrupted',
  effects: Record<string, number>,
): void {
  ctx.log.append({
    type, worldTime: ctx.worldTime, simVersion: '', patchId, actors,
    goal: ctx.choice.goal, conditions, outcome, effects,
    causalParents: [], confidence: 'authoritative',
  });
}

/**
 * Steps one patch toward a destination that may be several patches away, since perception now
 * reaches further than a single step. Movement is still one patch per tick; only the choice of
 * which neighbour changed.
 */
function stepToward(ctx: BehaviourContext, destination: number): number {
  const here = ctx.patches[ctx.agent.patchId]!;
  if (destination === here.id) return here.id;

  const target = ctx.patches[destination]!;
  let best = here.neighbours[0] ?? here.id;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of here.neighbours) {
    const candidate = ctx.patches[id]!;
    const distance = Math.abs(candidate.x - target.x) + Math.abs(candidate.y - target.y);
    if (distance < bestDistance) { bestDistance = distance; best = id; }
  }
  return best;
}

function moveTo(ctx: BehaviourContext, patchId: number): void {
  const from = ctx.agent.patchId;
  const next = stepToward(ctx, patchId);
  if (next === from) return;
  ctx.agent.previousPatchId = from;
  ctx.agent.patchId = next;
  ctx.agent.state = 'travelling';
  emit(ctx, 'moved', patchId, [ctx.agent.id], { from }, 'success', {});
}

function feed(ctx: BehaviourContext): void {
  const patch = ctx.patches[ctx.agent.patchId]!;
  const target = ctx.percept.bestFood;

  const wanted0 = (ctx.species.diet.dailyIntakeKg / 24) * ctx.hours;
  void wanted0;
  // A ration is an hour's share of a day's food, spread over the hours an animal actually
  // feeds. A hungry one takes up to twice that, which is how it recovers rather than merely
  // breaking even.
  const ration = (ctx.species.diet.dailyIntakeKg / FORAGING_HOURS_PER_DAY) * ctx.hours;
  const wanted = appetite(ration, ctx.agent.drives.hunger, ctx.agent.massKg, ctx.hours);
  const available = patch.plant.grass + patch.plant.browse;

  // Move only if this patch cannot feed the animal now. Otherwise eat where it stands.
  if (available < wanted && target !== null && target.patchId !== patch.id) {
    moveTo(ctx, target.patchId);
    return;
  }

  const wantedHere = Math.min(wanted, available);
  if (wantedHere <= 0) { ctx.agent.state = 'travelling'; return; }

  // Take from each pool no more than it holds, and count only what was actually taken.
  // Splitting by `eaten * share` could overshoot a pool by one unit in the last place when an
  // animal ate a patch bare, leaving -2e-16 kg of grass — which is still negative biomass.
  const grassShare = patch.plant.grass / available;
  const fromGrass = Math.min(patch.plant.grass, wantedHere * grassShare);
  const fromBrowse = Math.min(patch.plant.browse, wantedHere - fromGrass);
  patch.plant.grass -= fromGrass;
  patch.plant.browse -= fromBrowse;
  const eaten = fromGrass + fromBrowse;
  // Metabolised within the tick; the nutrients return to this patch's soil.
  patch.soilNutrients += eaten * NUTRIENT_PER_KG_BIOMASS;

  // Hunger is an energy deficit measured in days of intake. A full day's ration offsets
  // exactly a day of hunger, so an animal that cannot find its ration genuinely goes
  // hungry — which is what makes the food supply limit the population rather than
  // decorate it. Before this, an animal stayed fed on under two percent of its ration.
  ctx.agent.drives.hunger = clamp01(
    ctx.agent.drives.hunger - (eaten / ctx.species.diet.dailyIntakeKg) * HUNGER_PER_DAY,
  );
  ctx.agent.state = 'grazing';
  emit(ctx, 'fed', patch.id, [ctx.agent.id],
    { hunger: ctx.agent.drives.hunger, available }, 'success', { kg: eaten });
}

function drink(ctx: BehaviourContext): void {
  const patch = ctx.patches[ctx.agent.patchId]!;
  const target = ctx.percept.bestWater;

  // An animal at water drinks its fill: whatever takes its thirst back to nothing. Rationed to
  // a fraction an hour, a thirsty gaur drank for an hour, got hungry, walked off to pasture and
  // was thirsty again before it returned, and in the dry season the herd died commuting.
  const ration = (ctx.species.diet.waterNeedLPerDay / DRINKING_HOURS_PER_DAY) * ctx.hours;
  const deficit = (ctx.agent.drives.thirst / THIRST_PER_DAY) * ctx.species.diet.waterNeedLPerDay;
  const wanted = Math.max(ration, deficit);

  // Same rule as feeding: drink what is here unless there is not enough of it.
  if (patch.waterVolume < wanted && target !== null && target.patchId !== patch.id) {
    moveTo(ctx, target.patchId);
    return;
  }
  if (patch.waterVolume <= 0) { ctx.agent.state = 'travelling'; return; }
  const drunk = Math.min(wanted, patch.waterVolume);
  patch.waterVolume -= drunk;
  ctx.agent.drives.thirst = clamp01(
    ctx.agent.drives.thirst - (drunk / ctx.species.diet.waterNeedLPerDay) * THIRST_PER_DAY,
  );
  ctx.agent.state = 'drinking';
  emit(ctx, 'drank', patch.id, [ctx.agent.id],
    { thirst: ctx.agent.drives.thirst }, 'success', { litres: drunk });
}

function rest(ctx: BehaviourContext): void {
  ctx.agent.state = 'resting';
  ctx.agent.stamina = clamp01((ctx.agent.stamina ?? 1) + 0.25 * ctx.hours);
  emit(ctx, 'rested', ctx.agent.patchId, [ctx.agent.id],
    { fatigue: ctx.agent.drives.fatigue }, 'success', { hours: ctx.hours });
}

/**
 * Wandering, with herd cohesion.
 *
 * A species whose config says it lives in herds, troops, packs or families keeps company: when
 * it finds itself with fewer companions than its group needs, it moves toward the neighbouring
 * patch holding the most of its own kind. Without this a herd species is just a scatter of
 * loners that never meets a mate and never gains the collective vigilance that makes a herd
 * worth being in.
 */
function wander(ctx: BehaviourContext): void {
  const options = ctx.percept.patch.neighbours;
  if (options.length === 0) { ctx.agent.state = 'resting'; return; }

  const structure = ctx.species.social.structure;
  const gregarious = structure === 'herd' || structure === 'troop'
    || structure === 'pack' || structure === 'family';

  if (gregarious) {
    // Cohesion pulls an animal back only when it is genuinely alone. Holding a whole herd on
    // one 300 m patch would strip it bare and leave everyone too hungry to breed; loose
    // association is enough to keep a herd findable.
    // Loose association: enough companions to keep a herd findable, few enough that they do
    // not strip a single 300 m patch and starve themselves out of breeding condition.
    const countHere = ctx.percept.herdSize;
    const cohesionTarget = Math.min(3, ctx.species.social.groupSize[0]);

    if (countHere < cohesionTarget) {
      // First try the local gradient: a neighbouring patch holding more of its own kind.
      let bestPatch: number | null = null;
      let bestCount = countHere;
      for (const patchId of options) {
        let count = 0;
        for (const other of ctx.view.agentsInPatch(patchId)) {
          if (other.alive && other.speciesId === ctx.agent.speciesId) count++;
        }
        if (count > bestCount) { bestCount = count; bestPatch = patchId; }
      }
      if (bestPatch !== null) { moveTo(ctx, bestPatch); return; }

      // A gradient only helps if there is one. Scattered across four hundred patches there is
      // not, so a separated animal heads for where its group actually is. Without this, herd
      // species drift apart after the first day and never meet a mate again.
      const groupId = ctx.agent.groupId;
      if (groupId != null) {
        const home = ctx.view.groupPatch(groupId);
        if (home !== null && home !== ctx.agent.patchId) { moveTo(ctx, home); return; }
      }
    }
  }

  // Prefer not to double back. A random walk covers ground as the square root of its steps;
  // a patrol that keeps going covers it linearly, which is the difference between a predator
  // that finds prey and one that starves in a world full of it.
  const forward = options.filter((id) => id !== ctx.agent.previousPatchId);
  const pool = forward.length > 0 ? forward : options;
  moveTo(ctx, pool[ctx.rng.int(pool.length)]!);
}

function hunt(ctx: BehaviourContext): void {
  const hunting = ctx.species.hunting;
  if (hunting === undefined || ctx.percept.prey.length === 0) { wander(ctx); return; }

  const choice = choosePrey(ctx.percept.prey, ctx.rng);

  if (choice.patchId !== ctx.agent.patchId) { moveTo(ctx, choice.patchId); return; }

  const victim = choice.agent;
  ctx.agent.state = 'stalking';
  ctx.agent.targetId = victim.id;

  const outcome = resolveHunt({
    baseSuccess: hunting.baseSuccess,
    stalkConcealment: hunting.stalkConcealment,
    canopyCover: ctx.percept.patch.canopyCover,
    predatorStamina: ctx.agent.stamina ?? 1,
    predatorCondition: 1 - ctx.agent.drives.fatigue,
    preyEvasiveness: ctx.view.speciesOf(victim.speciesId).escape.evasiveness,
    preyCondition: 1 - victim.drives.fatigue,
    preyAlert: victim.drives.fear > 0.35,
    herdSize: choice.herdSize,
    distanceAtCommitM: hunting.commitDistanceM * (0.4 + ctx.rng.next() * 0.9),
    commitDistanceM: hunting.commitDistanceM,
  }, ctx.rng);

  ctx.agent.stamina = clamp01((ctx.agent.stamina ?? 1) - outcome.staminaSpent);
  // Being hunted is frightening whether or not it worked.
  victim.drives.fear = clamp01(victim.drives.fear + 0.8);

  if (!outcome.killed) {
    ctx.agent.state = 'chasing';
    ctx.agent.targetId = null;
    emit(ctx, 'hunt', ctx.agent.patchId, [ctx.agent.id, victim.id],
      { stage: outcome.stage, cover: ctx.percept.patch.canopyCover, herdSize: choice.herdSize },
      'failure', { staminaSpent: outcome.staminaSpent });
    return;
  }

  const carcass = ctx.services.kill(victim, 'predation', ctx.agent.id);
  ctx.agent.state = 'feeding';
  ctx.agent.targetId = null;
  emit(ctx, 'hunt', ctx.agent.patchId, [ctx.agent.id, victim.id],
    { stage: outcome.stage, cover: ctx.percept.patch.canopyCover, herdSize: choice.herdSize },
    'success', { staminaSpent: outcome.staminaSpent, preyMassKg: victim.massKg });
  consume(ctx, carcass);
}

function consume(ctx: BehaviourContext, carcass: Carcass): void {
  const ration = (ctx.species.diet.dailyIntakeKg / FORAGING_HOURS_PER_DAY) * ctx.hours;
  const wanted = appetite(ration, ctx.agent.drives.hunger, ctx.agent.massKg, ctx.hours);
  const available = edibleMass(carcass.biomass);
  const wantedHere = Math.min(wanted, available);
  if (wantedHere <= 0) return;

  // Same exact accounting as grazing: never take more from a tissue than it holds, and count
  // only what was actually taken, so the soil receives exactly what left the carcass.
  const muscleShare = carcass.biomass.muscle / available;
  const fromMuscle = Math.min(carcass.biomass.muscle, wantedHere * muscleShare);
  const fromOrgan = Math.min(carcass.biomass.organ, wantedHere - fromMuscle);
  carcass.biomass.muscle -= fromMuscle;
  carcass.biomass.organ -= fromOrgan;
  const eaten = fromMuscle + fromOrgan;

  const patch = ctx.patches[carcass.patchId]!;
  patch.soilNutrients += eaten * NUTRIENT_PER_KG_BIOMASS;

  carcass.consumers.push({ agentId: ctx.agent.id, at: ctx.worldTime, kg: eaten });
  ctx.agent.drives.hunger = clamp01(
    ctx.agent.drives.hunger - (eaten / ctx.species.diet.dailyIntakeKg) * HUNGER_PER_DAY,
  );

  // Carrion carries pathogens. Tolerance is a species trait: vultures shrug it off, jackals do not.
  const exposure = carcass.pathogenLoad * (1 - ctx.species.diet.carrionTolerance);
  if (exposure > 0 && ctx.rng.bool(exposure * 0.02 * ctx.hours)) {
    ctx.agent.drives.fatigue = clamp01(ctx.agent.drives.fatigue + 0.2);
  }

  ctx.services.removeCarcassIfSpent(carcass);
}

function scavenge(ctx: BehaviourContext): void {
  const found = ctx.percept.carrion;
  if (found === null) { wander(ctx); return; }
  if (found.patchId !== ctx.agent.patchId) { moveTo(ctx, found.patchId); return; }

  const before = edibleMass(found.carcass.biomass);
  ctx.agent.state = 'feeding';
  consume(ctx, found.carcass);
  const taken = before - edibleMass(found.carcass.biomass);

  emit(ctx, 'scavenged', found.patchId, [ctx.agent.id, found.carcass.originId],
    { species: found.carcass.speciesId, decayStage: found.carcass.decayStage },
    taken > 0 ? 'success' : 'failure', { kg: taken });
}

function flee(ctx: BehaviourContext): void {
  const options = ctx.percept.patch.neighbours;
  const threat = ctx.percept.threat;

  ctx.agent.state = 'fleeing';
  ctx.agent.stamina = clamp01((ctx.agent.stamina ?? 1) - 0.18 * ctx.hours);
  ctx.agent.drives.fatigue = clamp01(ctx.agent.drives.fatigue + 0.12 * ctx.hours);

  if (options.length === 0) return;
  // Run anywhere the threat is not.
  const away = options.filter((id) => id !== threat?.patchId);
  const pool = away.length > 0 ? away : options;
  const destination = pool[ctx.rng.int(pool.length)]!;

  ctx.agent.patchId = destination;
  emit(ctx, 'fled', destination, [ctx.agent.id],
    { fear: ctx.agent.drives.fear, from: ctx.percept.patch.id },
    'success', {});
}

export function executeGoal(ctx: BehaviourContext): void {
  ctx.agent.currentGoal = ctx.choice.goal;
  ctx.agent.alternativeGoal = ctx.choice.alternative;
  ctx.agent.goalScore = ctx.choice.score;

  switch (ctx.choice.goal) {
    case 'find_food': return feed(ctx);
    case 'find_water': return drink(ctx);
    case 'rest': return rest(ctx);
    case 'wander': return wander(ctx);
    case 'hunt': return hunt(ctx);
    case 'scavenge': return scavenge(ctx);
    case 'flee': return flee(ctx);
  }
}
