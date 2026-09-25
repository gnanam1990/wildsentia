import type { Drives, GoalId } from '../types/agent.js';

/** What a thought bubble may read. Every field is live planner state; nothing is authored. */
export interface ThoughtInput {
  state: string;
  currentGoal: GoalId;
  alternativeGoal: GoalId | null;
  /** Utility of the chosen goal. Low means the planner had no strong reason for anything. */
  goalScore: number;
  drives: Drives;
  /** Has a family dependency; this alone does not prove physical proximity. */
  dependent: boolean;
}

export interface Thought {
  text: string;
  /** The facts the text was built from, shown beside it so a watcher can check the wording. */
  basis: string[];
  /** False when the planner had no clear answer and the bubble says so. */
  confident: boolean;
}

/** Below this the planner's choice was barely above noise, so the bubble admits it. */
const UNCLEAR_SCORE = 0.12;

const pct = (value: number): string => `${Math.round(value * 100)}%`;

function doing(input: ThoughtInput): string {
  const { state, currentGoal: goal, drives: d } = input;
  switch (goal) {
    case 'find_water':
      if (state === 'drinking') return 'Drinking';
      return d.thirst > 0.7 ? 'Thirsty — heading for water' : 'Going to drink';
    case 'find_food':
      if (state === 'grazing') return 'Grazing';
      return d.hunger > 0.7 ? 'Hungry — looking for better pasture' : 'Moving to fresh grazing';
    case 'hunt':
      if (state === 'stalking') return 'Stalking — keeping low';
      if (state === 'chasing') return 'Chasing';
      if (state === 'feeding') return 'Feeding on its kill';
      return 'Hunting — looking for a weak one';
    case 'scavenge':
      return state === 'feeding' ? 'Feeding on a carcass' : 'Found carrion — going to feed';
    case 'flee':
      return 'Running — a predator is close';
    case 'rest':
      return d.fatigue > 0.7 ? 'Exhausted — resting' : 'Resting';
    case 'breed':
      return 'Looking for a mate';
    case 'care_for_young':
      return state === 'travelling' ? 'Returning to its young' : 'Attempting to care for its young';
    case 'follow_parent':
      return state === 'travelling' ? 'Trying to follow its mother' : 'Waiting at its mother’s last observed location';
    case 'seek_nursing':
      return state === 'travelling' ? 'Returning to its nursing site' : 'Waiting at its nursing site';
    case 'collect_pack_food':
      return 'Trying to collect food for its pack';
    case 'deliver_pack_food':
      return state === 'travelling' ? 'Carrying food back to its pack' : 'Attempting to share carried food';
    case 'wait_for_pack_food':
      return 'Waiting for a pack member bringing food';
    case 'wander':
    default:
      return 'Wandering — no strong need right now';
  }
}

/** A runner-up worth mentioning: one that pulls against what the animal is doing. */
function but(input: ThoughtInput): string | null {
  const { alternativeGoal: alt, currentGoal: goal, drives: d } = input;
  if (alt === 'flee' && goal !== 'flee' && d.fear > 0.3) return 'uneasy — watching for danger';
  if (alt === 'find_water' && goal !== 'find_water' && d.thirst > 0.6) return 'getting thirsty';
  if (alt === 'find_food' && goal !== 'find_food' && d.hunger > 0.6) return 'getting hungry';
  if (alt === 'rest' && goal !== 'rest' && d.fatigue > 0.6) return 'tiring';
  return null;
}

/**
 * The bubble above a watched animal (spec §10.3): what it is doing and why, from the planner's
 * chosen goal, the drive behind it and the runner-up. Wording is a template; a model may later
 * rephrase it for tone, never for substance.
 */
export function thoughtFor(input: ThoughtInput): Thought {
  const d = input.drives;
  const basis = [
    `goal ${input.currentGoal}`,
    `state ${input.state}`,
    `hunger ${pct(d.hunger)}`, `thirst ${pct(d.thirst)}`, `fatigue ${pct(d.fatigue)}`, `fear ${pct(d.fear)}`,
  ];
  if (input.alternativeGoal !== null) basis.push(`runner-up ${input.alternativeGoal}`);

  if (input.dependent) basis.unshift('family dependency; proximity not implied');
  if (input.currentGoal === 'wander' && input.goalScore < UNCLEAR_SCORE) {
    return { text: 'Unclear — moving without an obvious goal', basis: [`score ${input.goalScore.toFixed(2)}`, ...basis], confident: false };
  }

  const main = doing(input);
  const against = but(input);
  return { text: against === null ? main : `${main}, but ${against}`, basis, confident: true };
}
