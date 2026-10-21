/**
 * How fit an animal is, from how well it is kept (docs/2026-10-21-congo-fitness.md): fed, watered,
 * rested, in body condition and unhurt. The live layer turns it into speed, breath in the sprint,
 * and the odds of a catch, so an agent that keeps its animal well outruns and outhunts one that
 * neglects it. Wild hours in the simulation are not changed by it.
 */
export interface FitnessInputs {
  drives: { hunger: number; thirst: number; fatigue: number };
  /** Body condition, 0-1, where the species keeps one (sim_0.37); taken as 1 elsewhere. */
  condition?: number | undefined;
  /** A contact wound's severity, 0-1. */
  woundSeverity?: number | undefined;
}

export interface Fitness { score: number; fed: number; watered: number; rested: number; condition: number; hurt: number }

const unit = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const round = (v: number) => Math.round(v * 1000) / 1000;

export function fitnessOf(i: FitnessInputs): Fitness {
  const fed = unit(1 - i.drives.hunger), watered = unit(1 - i.drives.thirst), rested = unit(1 - i.drives.fatigue);
  const condition = unit(i.condition ?? 1), hurt = unit(i.woundSeverity ?? 0);
  const kept = 0.3 * fed + 0.25 * watered + 0.25 * rested + 0.2 * condition;
  return { score: round(unit(kept * (1 - 0.5 * hurt))), fed: round(fed), watered: round(watered), rested: round(rested), condition: round(condition), hurt: round(hurt) };
}

/**
 * The fitness at which a live chase runs at the species' own figures: an animal kept about as well
 * as a wild one keeps itself (needs about a third met short). Fitter than that is faster, weaker slower.
 */
export const EVEN_FITNESS = 0.75;
/** Hunger, thirst and fatigue each at this (with no condition or wound kept) give EVEN_FITNESS. */
export const EVEN_NEED = 0.3125;

/**
 * What a fitness does in a live chase: `speed` multiplies every gait (0.7 to 1.1), `breath` how
 * long a sprint lasts and how fast breath comes back (0.4 to 1.2), `grip` a hunter's odds of
 * holding its prey (0.4 to 1.2), `dodge` the hunter's odds when this animal is the prey (1.6 to
 * 0.8). Each is exactly 1 at EVEN_FITNESS.
 */
export function fitnessEffects(score: number): { speed: number; breath: number; grip: number; dodge: number } {
  const d = unit(score) - EVEN_FITNESS;
  return { speed: round(1 + 0.4 * d), breath: round(1 + 0.8 * d), grip: round(1 + 0.8 * d), dodge: round(1 - 0.8 * d) };
}

/** A fitness in a word, for a glance at another animal. */
export function fitnessLabel(score: number): 'fit' | 'fair' | 'weak' {
  return score >= 0.75 ? 'fit' : score >= 0.5 ? 'fair' : 'weak';
}
