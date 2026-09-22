import { type Agent, type GoalId, type Rng, type SpeciesConfig } from '@vana/shared';
import { edibleMass } from '../fields/decomposition.js';
import { goalsFor } from './archetypes.js';
import type { Percept } from './perception.js';

export interface GoalChoice {
  goal: GoalId;
  score: number;
  alternative: GoalId | null;
}

const NOISE = 0.05;

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
): GoalChoice {
  const d = agent.drives;
  const stamina = agent.stamina ?? 1;

  const foodOpportunity = percept.bestFood ? Math.min(1, percept.bestFood.kg / 500) : 0.05;
  const waterOpportunity = percept.bestWater ? Math.min(1, percept.bestWater.litres / 500) : 0.05;
  const preyOpportunity = percept.prey.length > 0 ? Math.min(1, percept.prey.length / 3) : 0;
  const carrionOpportunity = percept.carrion
    ? Math.min(1, edibleMass(percept.carrion.carcass.biomass) / 20)
    : 0;

  // Desperation. Past these thresholds the need outranks fear, because an animal that never
  // drinks dies just as surely as one that is caught.
  const thirstDesperation = Math.max(0, d.thirst - 0.72) * 6;
  const hungerDesperation = Math.max(0, d.hunger - 0.80) * 4;

  const all: Record<GoalId, number> = {
    find_food: d.hunger * d.hunger * (0.25 + foodOpportunity) + hungerDesperation,
    find_water: d.thirst * d.thirst * (0.25 + waterOpportunity) + thirstDesperation,
    rest: d.fatigue * d.fatigue * (1 - d.hunger * 0.5) * (1 - d.thirst * 0.5),
    wander: 0.08 + (1 - d.hunger) * (1 - d.thirst) * 0.05,
    // A hunt is only worth starting with prey in sight and the legs to chase it.
    hunt: d.hunger * d.hunger * preyOpportunity * stamina,
    // Carrion is cheaper than a hunt, so a hungry scavenger prefers it strongly.
    scavenge: d.hunger * carrionOpportunity * 1.35,
    // Fear outranks ordinary needs but not desperate ones, and an exhausted animal cannot
    // keep running however frightened it is.
    flee: d.fear * d.fear * 1.8 * (0.35 + stamina * 0.65),
  };

  const allowed = goalsFor(species.archetype);
  const ranked = allowed
    .map((goal) => ({ goal, score: all[goal] + rng.next() * NOISE }))
    .sort((a, b) => b.score - a.score);

  const winner = ranked[0]!;
  return { goal: winner.goal, score: winner.score, alternative: ranked[1]?.goal ?? null };
}
