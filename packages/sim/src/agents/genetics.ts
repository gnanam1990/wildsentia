import { TRAIT_IDS, type Rng, type Traits } from '@vana/shared';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Spread of the mutation around the mid-parent value. Small enough that lineages stay legible. */
export const MUTATION_SD = 0.06;

/**
 * How hard close breeding hits. At a coefficient of 0.25 — the value for full siblings or for
 * parent and offspring — disease resistance loses a quarter of its inherited value. This is
 * what makes dispersal matter rather than being decoration.
 */
export const INBREEDING_PENALTY = 1.0;

export function foundingTraits(rng: Rng): Traits {
  const traits = {} as Traits;
  for (const id of TRAIT_IDS) traits[id] = clamp01(rng.gaussian(0.5, 0.16));
  return traits;
}

/**
 * Mid-parent value plus bounded mutation. A child resembles its parents without being either
 * of them, which is what lets a lineage carry a tendency across generations.
 */
export function inheritTraits(
  mother: Traits,
  father: Traits,
  rng: Rng,
  inbreedingCoefficient = 0,
): Traits {
  const child = {} as Traits;
  for (const id of TRAIT_IDS) {
    const midParent = (mother[id] + father[id]) / 2;
    child[id] = clamp01(midParent + rng.gaussian(0, MUTATION_SD));
  }
  // Inbreeding depression lands on disease resistance, the trait that decides who survives a
  // bad season. It is not cosmetic.
  child.diseaseResistance = clamp01(
    child.diseaseResistance * (1 - inbreedingCoefficient * INBREEDING_PENALTY),
  );
  return child;
}

/** Trait-adjusted evasiveness: endurance and boldness both help an animal get away. */
export function effectiveEvasiveness(base: number, traits: Traits): number {
  return clamp01(base * (0.8 + traits.endurance * 0.25 + traits.boldness * 0.1));
}

/** Trait-adjusted flight distance: a bolder animal lets a predator come closer. */
export function effectiveFlightInitiation(base: number, traits: Traits): number {
  return base * (1.3 - traits.boldness * 0.6);
}
