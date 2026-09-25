import type { WorldOptions } from './world.js';

/**
 * The canonical forest: what the live server boots and what the soak measures. Both import
 * these, so the world people watch is the world the soak has proven can sustain itself.
 */

/**
 * Seeded at the prey density a tiger reserve actually carries, not at round numbers.
 *
 * Four tigers and twelve dhole need roughly five hundred ungulates a year between them. A
 * sustainable offtake is ten to twenty percent of the standing herd, so the herd has to be
 * two to five thousand animals — which is the sixty-odd ungulates per km² that Kanha and
 * Nagarahole carry, not the twenty per km² this was seeded at.
 *
 * Measured at twenty per km², the chital were conceiving perfectly well: three hundred and
 * forty-five were pregnant by day ten. They were simply eaten before a two hundred and thirty
 * day gestation could finish.
 */
export const FOREST_POPULATION: Record<string, number> = {
  chital: 1400, sambar: 450, hare: 900, langur: 300, squirrel: 220, boar: 500,
  gaur: 200, elephant: 8,
  tiger: 4, dhole: 12,
  jackal: 40, vulture: 25,
};

/**
 * Minimum viable population. Below this a species is rescued by dispersal from off-map
 * (spec §6.5), because a closed 36 km² patch of a much larger landscape would not really be
 * the last refuge of anything.
 *
 * These are floors, not targets. A healthy run should sit well above them and touch them rarely;
 * heavy immigration is a signal that breeding is not carrying the population.
 */
export const FOREST_FLOOR: Record<string, number> = {
  chital: 30, sambar: 20, hare: 40, langur: 20, squirrel: 20, boar: 20,
  gaur: 10, elephant: 3,
  tiger: 2, dhole: 4,
  jackal: 6, vulture: 4,
};

/** Development island founding cohort, not a validated long-term carrying capacity. No rescue floors. */
export const ISLAND_POPULATION: Record<string, number> = Object.fromEntries(
  Object.entries(FOREST_POPULATION).map(([id, count]) => [id, Math.max(2, Math.round(count * 0.45))]),
);

/**
 * The forest is a thirty-six square kilometre window onto a larger one. Animals cross its edge
 * in proportion to how far it is from the density of the country around it (FOREST_POPULATION,
 * the density it was seeded at): a thousandth of the difference a day, both ways.
 */
export const FOREST_LANDSCAPE: NonNullable<WorldOptions['landscape']> = {
  regional: FOREST_POPULATION, exchangePerDay: 0.001,
};
