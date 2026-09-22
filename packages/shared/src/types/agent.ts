import type { PatchId } from './patch.js';
import type { WorldTime } from '../time.js';

export type AgentState =
  | 'resting' | 'grazing' | 'drinking' | 'travelling'
  | 'stalking' | 'chasing' | 'feeding' | 'fleeing' | 'dead';

export const GOAL_IDS = [
  'find_food', 'find_water', 'rest', 'wander', 'hunt', 'scavenge', 'flee',
] as const;
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
