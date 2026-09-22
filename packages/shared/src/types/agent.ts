import type { PatchId } from './patch.js';
import type { WorldTime } from '../time.js';

export type AgentState = 'resting' | 'grazing' | 'drinking' | 'travelling' | 'dead';

export const GOAL_IDS = ['find_food', 'find_water', 'rest', 'wander'] as const;
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
