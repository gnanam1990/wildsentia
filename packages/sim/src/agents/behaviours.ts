import {
  NUTRIENT_PER_KG_BIOMASS,
  type Agent, type Patch, type Rng, type SpeciesConfig, type WorldTime,
} from '@vana/shared';
import type { EventLog } from '../events/log.js';
import type { GoalChoice } from './goals.js';
import type { Percept } from './perception.js';

export interface BehaviourContext {
  agent: Agent;
  species: SpeciesConfig;
  patches: Patch[];
  percept: Percept;
  choice: GoalChoice;
  hours: number;
  worldTime: WorldTime;
  log: EventLog;
  rng: Rng;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function moveTo(ctx: BehaviourContext, patchId: number): void {
  const from = ctx.agent.patchId;
  if (patchId === from) return;
  ctx.agent.patchId = patchId;
  ctx.agent.state = 'travelling';
  ctx.log.append({
    type: 'moved', worldTime: ctx.worldTime, simVersion: '', patchId,
    actors: [ctx.agent.id], goal: ctx.choice.goal,
    conditions: { from },
    outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative',
  });
}

function feed(ctx: BehaviourContext): void {
  const patch = ctx.patches[ctx.agent.patchId]!;
  const target = ctx.percept.bestFood;

  if (target && target.patchId !== patch.id) {
    moveTo(ctx, target.patchId);
    return;
  }

  const wanted = (ctx.species.diet.dailyIntakeKg / 24) * ctx.hours;
  const available = patch.plant.grass + patch.plant.browse;
  const eaten = Math.min(wanted, available);

  if (eaten <= 0) {
    ctx.agent.state = 'travelling';
    return;
  }

  // Take proportionally from whatever the patch actually holds.
  const grassShare = available > 0 ? patch.plant.grass / available : 0;
  patch.plant.grass -= eaten * grassShare;
  patch.plant.browse -= eaten * (1 - grassShare);

  // Mass eaten is metabolised within the tick; its nutrients return to this patch's soil.
  patch.soilNutrients += eaten * NUTRIENT_PER_KG_BIOMASS;

  ctx.agent.drives.hunger = clamp01(
    ctx.agent.drives.hunger - (eaten / Math.max(wanted, 1e-9)) * 0.35,
  );
  ctx.agent.state = 'grazing';

  ctx.log.append({
    type: 'fed', worldTime: ctx.worldTime, simVersion: '', patchId: patch.id,
    actors: [ctx.agent.id], goal: 'find_food',
    conditions: { hunger: ctx.agent.drives.hunger, available },
    outcome: 'success', effects: { kg: eaten }, causalParents: [], confidence: 'authoritative',
  });
}

function drink(ctx: BehaviourContext): void {
  const patch = ctx.patches[ctx.agent.patchId]!;
  const target = ctx.percept.bestWater;

  if (target && target.patchId !== patch.id) {
    moveTo(ctx, target.patchId);
    return;
  }
  if (patch.waterVolume <= 0) {
    ctx.agent.state = 'travelling';
    return;
  }

  const wanted = (ctx.species.diet.waterNeedLPerDay / 24) * ctx.hours;
  const drunk = Math.min(wanted, patch.waterVolume);
  patch.waterVolume -= drunk;
  ctx.agent.drives.thirst = clamp01(
    ctx.agent.drives.thirst - (drunk / Math.max(wanted, 1e-9)) * 0.5,
  );
  ctx.agent.state = 'drinking';

  ctx.log.append({
    type: 'drank', worldTime: ctx.worldTime, simVersion: '', patchId: patch.id,
    actors: [ctx.agent.id], goal: 'find_water',
    conditions: { thirst: ctx.agent.drives.thirst },
    outcome: 'success', effects: { litres: drunk }, causalParents: [], confidence: 'authoritative',
  });
}

function rest(ctx: BehaviourContext): void {
  ctx.agent.state = 'resting';
  ctx.log.append({
    type: 'rested', worldTime: ctx.worldTime, simVersion: '', patchId: ctx.agent.patchId,
    actors: [ctx.agent.id], goal: 'rest',
    conditions: { fatigue: ctx.agent.drives.fatigue },
    outcome: 'success', effects: { hours: ctx.hours }, causalParents: [], confidence: 'authoritative',
  });
}

function wander(ctx: BehaviourContext): void {
  const options = ctx.percept.patch.neighbours;
  if (options.length === 0) {
    ctx.agent.state = 'resting';
    return;
  }
  moveTo(ctx, options[ctx.rng.int(options.length)]!);
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
  }
}
