import {
  NUTRIENT_PER_KG_BIOMASS, edibleMass,
  type Agent, type Carcass, type DeathCause, type Patch, type Rng,
  type SpeciesConfig, type WorldTime,
} from '@vana/shared';
import type { EventLog } from '../events/log.js';
import { resolveHunt } from './predation.js';
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

function moveTo(ctx: BehaviourContext, patchId: number): void {
  const from = ctx.agent.patchId;
  if (patchId === from) return;
  ctx.agent.patchId = patchId;
  ctx.agent.state = 'travelling';
  emit(ctx, 'moved', patchId, [ctx.agent.id], { from }, 'success', {});
}

function feed(ctx: BehaviourContext): void {
  const patch = ctx.patches[ctx.agent.patchId]!;
  const target = ctx.percept.bestFood;

  const wanted0 = (ctx.species.diet.dailyIntakeKg / 24) * ctx.hours;
  void wanted0;
  const wanted = (ctx.species.diet.dailyIntakeKg / 24) * ctx.hours;
  const available = patch.plant.grass + patch.plant.browse;

  // Move only if this patch cannot feed the animal now. Otherwise eat where it stands.
  if (available < wanted && target !== null && target.patchId !== patch.id) {
    moveTo(ctx, target.patchId);
    return;
  }

  const eaten = Math.min(wanted, available);
  if (eaten <= 0) { ctx.agent.state = 'travelling'; return; }

  const grassShare = available > 0 ? patch.plant.grass / available : 0;
  patch.plant.grass -= eaten * grassShare;
  patch.plant.browse -= eaten * (1 - grassShare);
  // Metabolised within the tick; the nutrients return to this patch's soil.
  patch.soilNutrients += eaten * NUTRIENT_PER_KG_BIOMASS;

  ctx.agent.drives.hunger = clamp01(ctx.agent.drives.hunger - (eaten / Math.max(wanted, 1e-9)) * 0.35);
  ctx.agent.state = 'grazing';
  emit(ctx, 'fed', patch.id, [ctx.agent.id],
    { hunger: ctx.agent.drives.hunger, available }, 'success', { kg: eaten });
}

function drink(ctx: BehaviourContext): void {
  const patch = ctx.patches[ctx.agent.patchId]!;
  const target = ctx.percept.bestWater;

  const wanted = (ctx.species.diet.waterNeedLPerDay / 24) * ctx.hours;

  // Same rule as feeding: drink what is here unless there is not enough of it.
  if (patch.waterVolume < wanted && target !== null && target.patchId !== patch.id) {
    moveTo(ctx, target.patchId);
    return;
  }
  if (patch.waterVolume <= 0) { ctx.agent.state = 'travelling'; return; }
  const drunk = Math.min(wanted, patch.waterVolume);
  patch.waterVolume -= drunk;
  ctx.agent.drives.thirst = clamp01(ctx.agent.drives.thirst - (drunk / Math.max(wanted, 1e-9)) * 0.5);
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

function wander(ctx: BehaviourContext): void {
  const options = ctx.percept.patch.neighbours;
  if (options.length === 0) { ctx.agent.state = 'resting'; return; }
  moveTo(ctx, options[ctx.rng.int(options.length)]!);
}

function hunt(ctx: BehaviourContext): void {
  const hunting = ctx.species.hunting;
  if (hunting === undefined || ctx.percept.prey.length === 0) { wander(ctx); return; }

  // Prefer the weakest reachable target — the simulation's version of picking off the
  // vulnerable. A tired, unwary animal scores lowest and is chosen first.
  const vulnerability = (candidate: (typeof ctx.percept.prey)[number]): number =>
    (1 - candidate.agent.drives.fatigue) * (1 - candidate.agent.drives.fear * 0.5);

  let choice = ctx.percept.prey[0]!;
  for (const candidate of ctx.percept.prey) {
    if (vulnerability(candidate) < vulnerability(choice)) choice = candidate;
  }

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
  const wanted = (ctx.species.diet.dailyIntakeKg / 24) * ctx.hours;
  const available = edibleMass(carcass.biomass);
  const eaten = Math.min(wanted, available);
  if (eaten <= 0) return;

  // Take muscle before organ, in proportion to what is left.
  const muscleShare = available > 0 ? carcass.biomass.muscle / available : 0;
  carcass.biomass.muscle -= eaten * muscleShare;
  carcass.biomass.organ -= eaten * (1 - muscleShare);

  const patch = ctx.patches[carcass.patchId]!;
  patch.soilNutrients += eaten * NUTRIENT_PER_KG_BIOMASS;

  carcass.consumers.push({ agentId: ctx.agent.id, at: ctx.worldTime, kg: eaten });
  ctx.agent.drives.hunger = clamp01(ctx.agent.drives.hunger - (eaten / Math.max(wanted, 1e-9)) * 0.45);

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
