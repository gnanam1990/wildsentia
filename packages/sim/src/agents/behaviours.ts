import {
  NUTRIENT_PER_KG_BIOMASS, edibleMass, takeEdibleMass, patchAtPosition, atWaterAccess, waterAccessPosition, waterContactPosition, WATER_CONTACT_RADIUS_M, landRayDistance, landWalkable, treeAnchorForPatch, treeAnchorGeometry,
  type Agent, type Carcass, type DeathCause, type Patch, type Rng, type SkillId,
  type SpeciesConfig, type WorldTime, type WorldPosition, type MovementTrace,
} from '@vana/shared';
import { confidenceOf, skillFactor } from './learning.js';
import { HUNGER_PER_DAY, THIRST_PER_DAY } from './drives.js';
import type { EventLog } from '../events/log.js';
import { choosePrey } from './predation.js';
import { resolveSpatialHunt } from './encounters.js';
import { canRetryPrey, rememberFailedHunt } from './huntMemory.js';
import type { GoalChoice } from './goals.js';
import type { Percept, WorldView } from './perception.js';
import { locateAgent, locateCarcass } from './spatial.js';
import { approachContact } from './movement.js';
import { navigate } from './navigation.js';
import { allowsDependentGoal, canEatMaternalCarcass, canHuntIndependently, locomotionFactor,
  needsOf, needsProvisioning } from './needs.js';
import { exposeToCarrion } from './illness.js';
import { exposeToContactWound } from './wound.js';
import { advanceTreeVertical } from './arboreal.js';

/** The only writes a behaviour may make outside its own agent and patch. */
export interface WorldServices {
  consumedWater?(litres: number): void;
  kill(victim: Agent, cause: DeathCause, killerId: string | null, context?: { at: number; causalParent: string }): Carcass;
  removeCarcassIfSpent(carcass: Carcass): void;
  /** An animal used a skill. The world records it and lets the young beside it learn. */
  practised(agent: Agent, skill: SkillId, success: boolean): void;
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
  /** Original decision end, retained when travel leaves time for a resource action. */
  endWorldTime?: WorldTime;
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
    type, worldTime: Math.floor(ctx.worldTime), simVersion: '', patchId, actors,
    goal: ctx.choice.goal, conditions, outcome, effects,
    causalParents: [], confidence: 'authoritative',
  });
}

function moveTo(ctx: BehaviourContext, patchId: number, fleeing = false, endpoint?: WorldPosition) {
  const from = ctx.agent.patchId;
  const result = navigate(ctx.agent, ctx.species, ctx.patches, patchId, ctx.choice.goal, ctx.worldTime, ctx.hours * 3600, fleeing, endpoint);
  ctx.agent.state = result.unreachable ? 'resting' : fleeing ? 'fleeing' : 'travelling';
  const event = ctx.log.append({
    type: fleeing ? 'fled' : 'moved', worldTime: Math.floor(ctx.worldTime + result.seconds), simVersion: '',
    patchId: ctx.agent.patchId, actors: [ctx.agent.id], goal: ctx.choice.goal,
    conditions: { from, destination: patchId, ...(endpoint ? { targetX: endpoint.x, targetZ: endpoint.z } : {}),
      ...(result.unreachable ? { reason: 'unreachable_terrain' } : {}) },
    outcome: result.unreachable ? 'abandoned' : result.trace.completed ? 'success' : 'interrupted',
    effects: { distanceM: result.distanceM, durationSeconds: result.seconds, sprintSeconds: result.sprintSeconds },
    causalParents: [], confidence: 'authoritative', movement: result.trace,
  });
  return { ...result, eventId: event.id };
}

function afterTravel(ctx: BehaviourContext, seconds: number): BehaviourContext {
  return { ...ctx, worldTime: ctx.worldTime + seconds, hours: Math.max(0, ctx.hours - seconds / 3600),
    endWorldTime: ctx.endWorldTime ?? ctx.worldTime + ctx.hours * 3600 };
}

function feed(ctx: BehaviourContext, mayMove = true): void {
  const patch = ctx.patches[ctx.agent.patchId]!;
  const target = ctx.percept.bestFood;

  // A ration is an hour's share of a day's food, spread over the hours an animal actually
  // feeds. A hungry one takes up to twice that, which is how it recovers rather than merely
  // breaking even.
  const dailyNeed = needsOf(ctx.agent, ctx.species).foodKg;
  const ration = (dailyNeed / FORAGING_HOURS_PER_DAY) * ctx.hours;
  // A practised forager crops more in the same hour than a clumsy one.
  const wanted = appetite(ration, ctx.agent.drives.hunger, ctx.agent.massKg, ctx.hours)
    * skillFactor(confidenceOf(ctx.agent, ctx.species, 'forage_efficiency'), 0.7, 1.3);
  const available = patch.plant.grass + patch.plant.browse
    + (patch.floweringGuild?.vegetativeKg ?? 0);

  // Move only if this patch cannot feed the animal now. Otherwise eat where it stands.
  if (mayMove && available < wanted && target !== null && target.patchId !== patch.id) {
    const travel = moveTo(ctx, target.patchId);
    if (travel.trace.completed && travel.seconds < ctx.hours * 3600) feed(afterTravel(ctx, travel.seconds), false);
    return;
  }
  delete ctx.agent.journey;

  const wantedHere = Math.min(wanted, available);
  if (wantedHere <= 0) { ctx.agent.state = 'travelling'; return; }

  // Take from each pool no more than it holds, and count only what was actually taken.
  // Splitting by `eaten * share` could overshoot a pool by one unit in the last place when an
  // animal ate a patch bare, leaving -2e-16 kg of grass — which is still negative biomass.
  const grassShare = patch.plant.grass / available;
  const fromGrass = Math.min(patch.plant.grass, wantedHere * grassShare);
  const browseWanted = wantedHere - fromGrass;
  const guildStock = patch.floweringGuild?.vegetativeKg ?? 0;
  const fromGuild = Math.min(guildStock, browseWanted * (guildStock
    / Math.max(Number.EPSILON, patch.plant.browse + guildStock)));
  const fromBrowse = Math.min(patch.plant.browse, browseWanted - fromGuild);
  patch.plant.grass -= fromGrass;
  patch.plant.browse -= fromBrowse;
  if (patch.floweringGuild) patch.floweringGuild.vegetativeKg -= fromGuild;
  const eaten = fromGrass + fromBrowse + fromGuild;
  // Metabolised within the tick; the nutrients return to this patch's soil.
  patch.soilNutrients += eaten * NUTRIENT_PER_KG_BIOMASS;

  // Hunger is an energy deficit measured in days of intake. A full day's ration offsets
  // exactly a day of hunger, so an animal that cannot find its ration genuinely goes
  // hungry — which is what makes the food supply limit the population rather than
  // decorate it. Before this, an animal stayed fed on under two percent of its ration.
  ctx.agent.drives.hunger = clamp01(
    ctx.agent.drives.hunger - (eaten / dailyNeed) * HUNGER_PER_DAY,
  );
  ctx.agent.state = 'grazing';
  if (eaten > 0) ctx.services.practised(ctx.agent, 'forage_efficiency', true);
  emit(ctx, 'fed', patch.id, [ctx.agent.id],
    { hunger: ctx.agent.drives.hunger, available }, 'success', { kg: eaten });
}

function drink(ctx: BehaviourContext, mayMove = true, causalParents: string[] = []): void {
  const patch = ctx.patches[ctx.agent.patchId]!;
  const target = ctx.percept.bestWater;

  // An animal at water drinks its fill: whatever takes its thirst back to nothing. Rationed to
  // a fraction an hour, a thirsty gaur drank for an hour, got hungry, walked off to pasture and
  // was thirsty again before it returned, and in the dry season the herd died commuting.
  const dailyNeed = needsOf(ctx.agent, ctx.species).waterL;
  const ration = (dailyNeed / DRINKING_HOURS_PER_DAY) * ctx.hours;
  const deficit = (ctx.agent.drives.thirst / THIRST_PER_DAY) * dailyNeed;
  // Up to a day's water in fifteen minutes, but never a full drink in zero remaining time.
  const wanted = Math.min(Math.max(ration, deficit), dailyNeed * 4 * ctx.hours);
  if (wanted <= 0) return;

  // Same rule as feeding: drink what is here unless there is not enough of it.
  if (mayMove && patch.waterVolume < wanted && target !== null && target.patchId !== patch.id) {
    const travel = moveTo(ctx, target.patchId, false, waterContactPosition(ctx.agent.id, target.patchId));
    if (travel.trace.completed && travel.seconds < ctx.hours * 3600) drink(afterTravel(ctx, travel.seconds), false, [travel.eventId]);
    return;
  }
  if (patch.waterVolume <= 0) { ctx.agent.state = 'travelling'; return; }
  if (!atWaterAccess(locateAgent(ctx.agent), patch.id)) {
    const travel = moveTo(ctx, patch.id, false, waterContactPosition(ctx.agent.id, patch.id));
    if (travel.trace.completed && travel.seconds < ctx.hours * 3600) drink(afterTravel(ctx, travel.seconds), false, [...causalParents, travel.eventId]);
    return;
  }
  delete ctx.agent.journey;
  const drunk = Math.min(wanted, patch.waterVolume);
  patch.waterVolume -= drunk;
  ctx.services.consumedWater?.(drunk);
  ctx.agent.drives.thirst = clamp01(
    ctx.agent.drives.thirst - (drunk / dailyNeed) * THIRST_PER_DAY,
  );
  ctx.agent.state = 'drinking';
  ctx.services.practised(ctx.agent, 'water_locations', true);
  const source = waterAccessPosition(patch.id), position = locateAgent(ctx.agent);
  position.heading = Math.atan2(source.x - position.x, source.z - position.z);
  ctx.log.append({ type: 'drank', worldTime: Math.floor(ctx.endWorldTime ?? ctx.worldTime + ctx.hours * 3600),
    simVersion: '', patchId: patch.id, position: { ...position }, actors: [ctx.agent.id], goal: ctx.choice.goal,
    conditions: { thirst: ctx.agent.drives.thirst, sourceX: source.x, sourceZ: source.z,
      contactRadiusM: WATER_CONTACT_RADIUS_M, arrivalWorldTime: ctx.worldTime, drinkingSeconds: ctx.hours * 3600 },
    outcome: 'success', effects: { litres: drunk }, causalParents, confidence: 'authoritative' });
}

function rest(ctx: BehaviourContext): void {
  delete ctx.agent.journey;
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
  if (ctx.agent.journey?.goal === ctx.choice.goal) { moveTo(ctx, ctx.agent.journey.destinationPatchId); return; }
  const options = ctx.percept.patch.neighbours.filter(id => landWalkable(ctx.patches[id]));
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
  const candidates = ctx.percept.prey.filter((p) => p.agent.alive
    && p.agent.patchId === p.patchId && p.agent.lastEncounterAt !== ctx.worldTime
    && (p.agent.altitudeM ?? 0) === 0
    && canRetryPrey(ctx.agent, p.agent.id, ctx.worldTime));
  if (hunting === undefined || candidates.length === 0) {
    delete ctx.agent.journey;
    ctx.agent.targetId = null; wander(ctx); return;
  }

  // Keep an approach commitment only while that living target remains perceptible and eligible.
  const choice = candidates.find((p) => p.agent.id === ctx.agent.targetId) ?? choosePrey(candidates, ctx.rng);
  ctx.agent.targetId = choice.agent.id;

  if (choice.patchId !== ctx.agent.patchId) { moveTo(ctx, choice.patchId); return; }
  delete ctx.agent.journey;

  const victim = choice.agent;
  ctx.agent.state = 'stalking';
  ctx.agent.targetId = victim.id;

  const preySpecies = ctx.view.speciesOf(victim.speciesId);
  const terrain = ctx.percept.patch.habitat;
  const predatorTerrainCost = ctx.species.locomotion.terrainCost[terrain];
  const preyTerrainCost = preySpecies.locomotion.terrainCost[terrain];
  const predatorScale = locomotionFactor(ctx.agent, ctx.species);
  const preyScale = locomotionFactor(victim, preySpecies);
  const predatorCondition = Math.max(0.15, 1 - ctx.agent.drives.fatigue * 0.5) * predatorScale;
  const preyCondition = Math.max(0.15, 1 - victim.drives.fatigue * 0.5) * preyScale;
  const outcome = resolveSpatialHunt({
    ...(ctx.percept.patch.islandSeed === undefined ? {} : { landBoundaryM: (p: WorldPosition, heading: number) => landRayDistance(ctx.patches, p, heading) }),
    predatorId: ctx.agent.id, preyId: victim.id, patchId: ctx.agent.patchId, worldTime: ctx.worldTime,
    predator: locateAgent(ctx.agent), prey: locateAgent(victim),
    predatorWalkMs: ctx.species.locomotion.walkMs * predatorScale * 0.45 / predatorTerrainCost,
    predatorSprintMs: ctx.species.locomotion.sprintMs * predatorCondition / predatorTerrainCost,
    preySprintMs: preySpecies.locomotion.sprintMs * preyCondition / preyTerrainCost,
    preyTrotMs: preySpecies.locomotion.trotMs * preyCondition / preyTerrainCost,
    predatorSprintSeconds: ctx.species.locomotion.sprintStaminaS,
    preySprintSeconds: Math.max(0.001, preySpecies.locomotion.sprintStaminaS * (victim.stamina ?? 1)),
    contactRadiusM: 0.35 + (ctx.species.body.shoulderHeightM + preySpecies.body.shoulderHeightM) * 0.25,
    secondsAvailable: ctx.hours * 3600,
    chaseStaminaCost: hunting.staminaCostPerChase,
    contest: {
    baseSuccess: hunting.baseSuccess,
    // Taught or practised technique moves both sides of the contest.
    stalkConcealment: Math.min(1, hunting.stalkConcealment
      * skillFactor(confidenceOf(ctx.agent, ctx.species, 'stalk_technique'), 0.8, 1.2)),
    canopyCover: ctx.percept.patch.canopyCover,
    predatorStamina: ctx.agent.stamina ?? 1,
    predatorCondition: 1 - ctx.agent.drives.fatigue,
    preyEvasiveness: Math.min(1, ctx.view.speciesOf(victim.speciesId).escape.evasiveness
      * skillFactor(confidenceOf(victim, ctx.view.speciesOf(victim.speciesId), 'predator_avoidance'), 0.8, 1.2)),
    preyCondition: 1 - victim.drives.fatigue,
    preyAlert: victim.drives.fear > 0.35,
    herdSize: choice.herdSize,
    commitDistanceM: hunting.commitDistanceM,
    },
  }, ctx.rng);

  const last = outcome.trace.samples.at(-1)!;
  ctx.agent.position = { ...last.predator };
  victim.position = { ...last.prey };
  for (const animal of [ctx.agent, victim]) {
    const patch = patchAtPosition(animal.position!);
    if (patch !== animal.patchId) { animal.previousPatchId = animal.patchId; animal.patchId = patch; }
  }
  ctx.agent.stamina = clamp01((ctx.agent.stamina ?? 1) - outcome.staminaSpent);
  const committed = outcome.trace.samples.some((s) => s.phase === 'chase' || s.phase === 'escape');
  if (committed) {
    let flightDistance = 0;
    for (let i = 1; i < outcome.trace.samples.length; i++) {
      const before = outcome.trace.samples[i - 1]!.prey; const after = outcome.trace.samples[i]!.prey;
      flightDistance += Math.hypot(after.x - before.x, after.z - before.z);
    }
    victim.stamina = clamp01((victim.stamina ?? 1)
      - 0.3 * flightDistance / (preySpecies.locomotion.sprintMs * preySpecies.locomotion.sprintStaminaS));
    victim.lastEncounterAt = ctx.worldTime;
    victim.drives.fear = clamp01(victim.drives.fear + 0.8);
    victim.state = 'fleeing';
    ctx.services.practised(ctx.agent, 'stalk_technique', outcome.killed);
    if (!outcome.killed) ctx.services.practised(victim, 'predator_avoidance', true);
  }
  const at = Math.floor(ctx.worldTime + last.seconds);
  const event = ctx.log.append({
    type: 'hunt', worldTime: at, simVersion: '', patchId: victim.patchId,
    actors: [ctx.agent.id, victim.id], goal: ctx.choice.goal,
    conditions: { stage: outcome.stage, predatorSpecies: ctx.agent.speciesId, preySpecies: victim.speciesId,
      cover: ctx.percept.patch.canopyCover, herdSize: choice.herdSize,
      distanceAtCommitM: outcome.distanceAtCommitM, durationSeconds: last.seconds },
    outcome: outcome.killed ? 'success'
      : outcome.stage === 'approaching' || outcome.stage === 'time_exhausted' ? 'interrupted'
      : outcome.stage === 'chase_abandoned' ? 'abandoned' : 'failure',
    effects: { staminaSpent: outcome.staminaSpent, ...(outcome.killed ? { preyMassKg: victim.massKg } : {}) },
    causalParents: [], confidence: 'authoritative', encounter: outcome.trace,
  });

  if (!outcome.killed) {
    exposeToContactWound(victim, event, ctx.endWorldTime ?? ctx.worldTime + ctx.hours * 3600, ctx.rng, ctx.log);
    const continuing = outcome.stage === 'approaching' || outcome.stage === 'time_exhausted';
    ctx.agent.state = continuing ? 'stalking' : 'resting';
    ctx.agent.targetId = continuing ? victim.id : null;
    if (!continuing) rememberFailedHunt(ctx.agent, victim.id, at);
    return;
  }

  const carcass = ctx.services.kill(victim, 'predation', ctx.agent.id, { at, causalParent: event.id });
  ctx.agent.state = 'feeding';
  ctx.agent.targetId = null;
  consume(ctx, carcass, last.seconds, event.id);
}

function consume(ctx: BehaviourContext, carcass: Carcass, elapsedSeconds = 0, causalParent?: string): void {
  // An eligible cub never inherits the adult's unrestricted carrion path through a stale
  // perception or a mother who died earlier in this decision. No debit before this check.
  if (needsProvisioning(ctx.agent, ctx.species)
    && !canEatMaternalCarcass(ctx.agent, ctx.species, carcass, ctx.view, ctx.worldTime)) return;
  const end = ctx.endWorldTime ?? ctx.worldTime + ctx.hours * 3600;
  // Another actor may create this body partway through the same coarse tick. Never grant
  // approach or feeding time before it exists, nor reuse time already spent hunting.
  const start = Math.max(ctx.worldTime + elapsedSeconds, carcass.diedAt);
  const secondsAvailable = Math.max(0, end - start);
  if (secondsAvailable === 0) return;
  const from = { ...locateAgent(ctx.agent) };
  const target = locateCarcass(carcass);
  const radius = Math.max(0.35, ctx.species.body.shoulderHeightM * 0.65);
  const habitat = ctx.patches[ctx.agent.patchId]!.habitat;
  const speed = ctx.species.locomotion.walkMs * locomotionFactor(ctx.agent, ctx.species)
    * Math.max(0.15, 1 - ctx.agent.drives.fatigue * 0.5) / ctx.species.locomotion.terrainCost[habitat];
  const movement = approachContact(from, target, speed, secondsAvailable, radius);
  ctx.agent.position = movement.position;
  const nextPatch = patchAtPosition(movement.position);
  if (nextPatch !== ctx.agent.patchId) { ctx.agent.previousPatchId = ctx.agent.patchId; ctx.agent.patchId = nextPatch; }
  const parents = causalParent ? [causalParent] : [];
  if (movement.distanceM > 0) {
    const event = ctx.log.append({
      type: 'moved', worldTime: Math.floor(start + movement.seconds), simVersion: '', patchId: ctx.agent.patchId,
      actors: [ctx.agent.id], goal: ctx.choice.goal,
      conditions: { reason: 'approach_carcass', carcassId: carcass.id, startWorldTime: start,
        fromX: from.x, fromZ: from.z, toX: movement.position.x, toZ: movement.position.z,
        targetX: target.x, targetZ: target.z, contactRadiusM: radius, speedMs: speed },
      outcome: movement.arrived ? 'success' : 'interrupted',
      effects: { distanceM: movement.distanceM, durationSeconds: movement.seconds },
      causalParents: [...parents], confidence: 'authoritative',
    });
    parents.push(event.id);
  }
  ctx.agent.state = movement.arrived ? 'feeding' : 'travelling';
  if (!movement.arrived) return;
  const feedingSeconds = Math.max(0, secondsAvailable - movement.seconds);
  if (feedingSeconds === 0) return;
  const hours = feedingSeconds / 3600;
  const dailyNeed = needsOf(ctx.agent, ctx.species).foodKg;
  const ration = (dailyNeed / FORAGING_HOURS_PER_DAY) * hours;
  const wanted = appetite(ration, ctx.agent.drives.hunger, ctx.agent.massKg, hours);
  const available = edibleMass(carcass.biomass);
  const wantedHere = Math.min(wanted, available);
  if (wantedHere <= 0) return;

  // Same exact accounting as grazing: never take more from a tissue than it holds, and count
  // only what was actually taken, so the soil receives exactly what left the carcass.
  const eaten = takeEdibleMass(carcass.biomass, wantedHere);

  const patch = ctx.patches[carcass.patchId]!;
  patch.soilNutrients += eaten * NUTRIENT_PER_KG_BIOMASS;

  // This is the completed aggregate meal, not a claim that it was all eaten on arrival.
  carcass.consumers.push({ agentId: ctx.agent.id, at: Math.floor(end), kg: eaten });
  ctx.agent.drives.hunger = clamp01(
    ctx.agent.drives.hunger - (eaten / dailyNeed) * HUNGER_PER_DAY,
  );

  const meal = ctx.log.append({
    type: ctx.choice.goal === 'hunt' ? 'fed' : 'scavenged', worldTime: Math.floor(end), simVersion: '',
    patchId: carcass.patchId, actors: [ctx.agent.id, carcass.originId], goal: ctx.choice.goal,
    conditions: { species: carcass.speciesId, decayStage: carcass.decayStage, carcassId: carcass.id,
      arrivalWorldTime: start + movement.seconds, feedingSeconds, contactRadiusM: radius },
    outcome: 'success', effects: { kg: eaten }, causalParents: parents, confidence: 'authoritative',
  });
  // Exposure is tied to this completed, positive-mass meal and its actual source carcass.
  // Merely seeing, approaching, or standing beside carrion cannot contract the illness.
  exposeToCarrion(ctx.agent, ctx.species, carcass, meal, dailyNeed, ctx.rng, ctx.log);
  ctx.services.removeCarcassIfSpent(carcass);
}

function scavenge(ctx: BehaviourContext): void {
  const found = ctx.percept.carrion;
  if (found === null || needsProvisioning(ctx.agent, ctx.species)
    && !canEatMaternalCarcass(ctx.agent, ctx.species, found.carcass, ctx.view, ctx.worldTime)) {
    delete ctx.agent.journey;
    if (needsProvisioning(ctx.agent, ctx.species)) {
      ctx.agent.currentGoal = 'rest'; ctx.agent.state = 'resting'; return;
    }
    wander(ctx); return;
  }
  if (found.patchId !== ctx.agent.patchId) {
    const travel = moveTo(ctx, found.patchId);
    if (travel.trace.completed && travel.seconds < ctx.hours * 3600) consume(afterTravel(ctx, travel.seconds), found.carcass, 0, travel.eventId);
    return;
  }
  delete ctx.agent.journey;
  consume(ctx, found.carcass);
}

function flee(ctx: BehaviourContext): void {
  const options = ctx.percept.patch.neighbours.filter(id => landWalkable(ctx.patches[id]));
  const threat = ctx.percept.threat;

  // Only an actual local ground predator can initiate the bounded tree escape. Dependent
  // young, pregnant animals and adults currently responsible for dependent offspring stay
  // with the existing ground/family policy. This grants no food, water or chase outcome.
  const raisingYoung = ctx.agent.offspringIds.some(id => {
    const child = ctx.view.agentById?.(id);
    return child?.alive && child.dependentOn === ctx.agent.id;
  });
  const anchor = threat?.patchId === ctx.agent.patchId && !needsProvisioning(ctx.agent, ctx.species)
    && ctx.agent.dependentOn === null && ctx.agent.pregnantSince === null && !raisingYoung
    ? treeAnchorForPatch(ctx.percept.patch) : null;
  if (anchor && (ctx.agent.speciesId === 'langur' || ctx.agent.speciesId === 'squirrel')) {
    climbToEscape(ctx, anchor);
    return;
  }

  ctx.agent.state = 'fleeing';
  if (options.length === 0) return;
  // Run anywhere the threat is not.
  const away = options.filter((id) => id !== threat?.patchId);
  const pool = away.length > 0 ? away : options;
  const saved = ctx.agent.journey;
  const destination = saved?.goal === 'flee' && saved.destinationPatchId !== threat?.patchId
    ? saved.destinationPatchId : pool[ctx.rng.int(pool.length)]!;
  const travel = moveTo(ctx, destination, true);
  // Stamina is the remaining fraction of the configured sprint duration; spending only a
  // small arbitrary fraction here would grant a fresh sprint after every partial decision.
  ctx.agent.stamina = clamp01((ctx.agent.stamina ?? 1) - travel.sprintSeconds / ctx.species.locomotion.sprintStaminaS);
  ctx.agent.drives.fatigue = clamp01(ctx.agent.drives.fatigue + 0.12 * travel.seconds / 3600);
}

/** One event for the actual ground approach and vertical segment. Two events in a single
 * hour would be deliberately rejected by the live movement index as ambiguous ownership. */
function climbToEscape(ctx: BehaviourContext, anchor: NonNullable<ReturnType<typeof treeAnchorForPatch>>): void {
  const agent = ctx.agent, startPatchId = agent.patchId, budget = ctx.hours * 3600;
  const endpoint = { x: anchor.x, z: anchor.z, heading: agent.position?.heading ?? 0 };
  const ground = navigate(agent, ctx.species, ctx.patches, anchor.patchId, 'flee', ctx.worldTime, budget, true, endpoint);
  // Reaching the trunk is not a completed ascent. Zero remaining time must never be
  // reported as a successful climb or replayed as if it acquired altitude.
  let trace: MovementTrace = { ...ground.trace, completed: false }, verticalDistanceM = 0, verticalSeconds = 0;
  if (ground.trace.completed && !ground.unreachable && ground.seconds < budget) {
    const vertical = advanceTreeVertical(agent, ctx.patches[anchor.patchId]!, 'ascend', 'flee', ctx.worldTime,
      budget - ground.seconds);
    if (!vertical.unreachable) {
      verticalDistanceM = vertical.distanceM; verticalSeconds = vertical.seconds;
      // The vertical segment starts at zero height. Make that boundary explicit so the
      // client can identify the adjacent altitude pair without treating the ground
      // approach as a climb or inventing a pose from an undefined starting altitude.
      const groundSamples = ground.trace.samples.map((sample, index) => index === ground.trace.samples.length - 1
        ? { ...sample, altitudeM: 0 } : sample);
      trace = { ...ground.trace, completed: vertical.trace.completed,
        samples: [...groundSamples, ...vertical.trace.samples.slice(1).map(sample => ({
          ...sample, seconds: ground.seconds + sample.seconds,
        }))] };
    }
  }
  const seconds = ground.seconds + verticalSeconds;
  agent.currentGoal = 'flee'; agent.alternativeGoal = ctx.choice.alternative;
  agent.goalScore = ctx.choice.score; agent.state = agent.altitudeM ? 'resting' : 'fleeing';
  agent.stamina = clamp01((agent.stamina ?? 1) - ground.sprintSeconds / ctx.species.locomotion.sprintStaminaS);
  agent.drives.fatigue = clamp01(agent.drives.fatigue + 0.12 * seconds / 3600);
  ctx.log.append({ type: 'tree_climbed', worldTime: Math.floor(ctx.worldTime + seconds), simVersion: '',
    patchId: agent.patchId, position: { ...locateAgent(agent) }, actors: [agent.id], goal: 'flee',
    conditions: { direction: 'ascend', treeAnchorId: anchor.id, reason: 'local_threat',
      from: startPatchId, destination: anchor.patchId },
    outcome: trace.completed ? 'success' : 'interrupted',
    effects: { distanceM: ground.distanceM + verticalDistanceM, horizontalDistanceM: ground.distanceM,
      verticalDistanceM, durationSeconds: seconds, sprintSeconds: ground.sprintSeconds },
    causalParents: [], confidence: 'authoritative', movement: trace });
}

/** A saved perched animal spends real time returning along its exact stable trunk. Ground
 * actions resume on the next decision, never retroactively in the remainder of this hour. */
export function descendPerchedAnimal(agent: Agent, patch: Patch, worldTime: WorldTime, hours: number,
  reason: 'threat_gone' | 'canopy_lost' | 'urgent_need', log: EventLog): void {
  const anchor = treeAnchorGeometry(patch.id);
  if (!anchor || !agent.altitudeM) throw new Error('descent requires a perched agent at a stable anchor');
  const vertical = advanceTreeVertical(agent, patch, 'descend', 'rest', worldTime, Math.min(3600, hours * 3600));
  if (vertical.unreachable) throw new Error('persisted tree descent became unreachable');
  agent.currentGoal = 'rest'; agent.alternativeGoal = null; agent.goalScore = 1;
  if (vertical.trace.completed) agent.state = 'resting';
  log.append({ type: 'tree_climbed', worldTime: Math.floor(worldTime + vertical.seconds), simVersion: '',
    patchId: patch.id, position: { ...locateAgent(agent) }, actors: [agent.id], goal: 'rest',
    conditions: { direction: 'descend', treeAnchorId: anchor.id, reason, from: patch.id, destination: patch.id },
    outcome: vertical.trace.completed ? 'success' : 'interrupted',
    effects: { distanceM: vertical.distanceM, horizontalDistanceM: 0, verticalDistanceM: vertical.distanceM,
      durationSeconds: vertical.seconds, sprintSeconds: 0 },
    causalParents: [], confidence: 'authoritative', movement: vertical.trace });
}

export function executeGoal(ctx: BehaviourContext): void {
  // Enforce abilities here too: callers cannot force adult behavior through a stale goal.
  if (!allowsDependentGoal(ctx.agent, ctx.species, ctx.choice.goal)
    || (ctx.choice.goal === 'hunt' && !canHuntIndependently(ctx.agent, ctx.species))) {
    ctx = { ...ctx, choice: { goal: 'rest', score: 1, alternative: null } };
    ctx.agent.targetId = null;
  }
  ctx.agent.currentGoal = ctx.choice.goal;
  if (ctx.agent.journey?.goal !== ctx.choice.goal) delete ctx.agent.journey;
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
