import type { PatchId } from './patch.js';
import type { WorldTime } from '../time.js';

export type AgentState =
  | 'resting' | 'grazing' | 'drinking' | 'travelling'
  | 'stalking' | 'chasing' | 'feeding' | 'fleeing' | 'dead'
  /** Walked out of this stretch of forest into the country around it. Alive, but gone. */
  | 'emigrated';

export const GOAL_IDS = [
  'find_food', 'find_water', 'rest', 'wander', 'hunt', 'scavenge', 'flee', 'breed',
] as const;

export type Sex = 'male' | 'female';

export const LIFE_STAGES = ['newborn', 'juvenile', 'subadult', 'adult', 'elder'] as const;
export type LifeStage = (typeof LIFE_STAGES)[number];

export const TRAIT_IDS = [
  'sizeTendency', 'boldness', 'endurance', 'sensoryAcuity', 'diseaseResistance', 'coatVariant',
] as const;
export type TraitId = (typeof TRAIT_IDS)[number];

/** Every trait is 0-1. Inherited once at birth and fixed for life. */
export type Traits = Record<TraitId, number>;
export type GoalId = (typeof GOAL_IDS)[number];

export function isGoalId(value: string): value is GoalId {
  return (GOAL_IDS as readonly string[]).includes(value);
}

export interface Drives {
  hunger: number;
  thirst: number;
  fatigue: number;
  fear: number;
}

export interface Agent {
  id: string;
  speciesId: string;
  /** Who this predator is currently working on. Null for everything else. */
  targetId?: string | null;
  /** 0-1. Spent by chases, recovered by rest. Separate from fatigue, which is whole-body. */
  stamina?: number;
  sex: Sex;
  ageDays: number;
  lifeStage: LifeStage;
  traits: Traits;
  /** Null for a founder. Everything born in the world names both. */
  motherId: string | null;
  fatherId: string | null;
  /** 0 for founders, one higher than the elder parent for everything born. */
  generation: number;
  /** Set while this animal still depends on its mother. */
  dependentOn: string | null;
  /** Where it came from last tick, so wandering becomes patrolling rather than a random walk. */
  previousPatchId?: number | null;
  /** The herd, troop, pack or family this animal belongs to. Null for solitary species. */
  groupId?: string | null;
  /** World time conception happened, or null. */
  pregnantSince: number | null;
  /** A female whose courtship failed is not receptive again until her next cycle. */
  nextOestrusAt?: number | null;
  /** World time this animal last gave birth, for the inter-birth interval. */
  lastBirthAt: number | null;
  offspringIds: string[];
  bornAt: WorldTime;
  massKg: number;
  patchId: PatchId;
  state: AgentState;
  currentGoal: GoalId;
  alternativeGoal: GoalId | null;
  goalScore: number;
  drives: Drives;
  alive: boolean;
}
