import { GOAL_IDS, type Agent, type GoalId, type Rng } from '@vana/shared';
import type { Percept } from './perception.js';

export interface GoalChoice {
  goal: GoalId;
  score: number;
  alternative: GoalId | null;
}

const NOISE = 0.05;

/** utility = drive x opportunity, plus bounded noise so identical animals diverge. */
export function selectGoal(agent: Agent, percept: Percept, rng: Rng): GoalChoice {
  const d = agent.drives;
  const foodOpportunity = percept.bestFood ? Math.min(1, percept.bestFood.kg / 500) : 0.05;
  const waterOpportunity = percept.bestWater ? Math.min(1, percept.bestWater.litres / 500) : 0.05;

  const scores: Record<GoalId, number> = {
    find_food: d.hunger * d.hunger * (0.25 + foodOpportunity),
    find_water: d.thirst * d.thirst * (0.25 + waterOpportunity),
    rest: d.fatigue * d.fatigue * (1 - d.hunger * 0.5) * (1 - d.thirst * 0.5),
    wander: 0.08 + (1 - d.hunger) * (1 - d.thirst) * 0.05,
  };

  const ranked = GOAL_IDS
    .map((goal) => ({ goal, score: scores[goal] + rng.next() * NOISE }))
    .sort((a, b) => b.score - a.score);

  const winner = ranked[0]!;
  return { goal: winner.goal, score: winner.score, alternative: ranked[1]?.goal ?? null };
}
