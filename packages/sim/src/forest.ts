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

/**
 * Development island founding cohort, not a validated long-term carrying capacity. No rescue
 * floors. sim_0.33.0 founds every species at the canonical forest's density per km² of land:
 * 12.24 km² of island land against the 36 km² forest is 0.34 of its counts (0.45 before, which
 * put 94 ungulates on each km², above the 5.3-63.8/km² Karanth et al. 2004 measured across
 * India, and grazed the island bare by the end of a dry season). That is about 71 ungulates per
 * km², the forest's reserve-calibrated density. The predators are set from field densities for
 * the island's land (sources in docs/2026-10-05-multi-year-ecology.md):
 * - tiger 2, one male and one female (16/100 km²; Karanth et al. 2004 found 3.2-16.8/100 km²
 *   rising with prey, and this island starts with more ungulates per km² than any of their sites);
 * - dhole 4, one pack at the smallest working size (0.33/km²; Bandipur's core held 0.35-0.9/km²,
 *   one pack ranges 27-85 km²), which is also what the land in one range holds (packCapacity);
 * - jackal 14 (1.1/km², the forest's density; Velavadar held 1-2/km², Moehlman and Jhala 2004).
 */
export const ISLAND_LAND_SHARE = 0.34;
export const ISLAND_POPULATION: Record<string, number> = {
  ...Object.fromEntries(Object.entries(FOREST_POPULATION).map(([id, count]) => [id, Math.max(2, Math.round(count * ISLAND_LAND_SHARE))])),
  tiger: 2, dhole: 4, jackal: 14,
};

/**
 * The forest is a thirty-six square kilometre window onto a larger one. Animals cross its edge
 * in proportion to how far it is from the density of the country around it (FOREST_POPULATION,
 * the density it was seeded at): a thousandth of the difference a day, both ways.
 */
export const FOREST_LANDSCAPE: NonNullable<WorldOptions['landscape']> = {
  regional: FOREST_POPULATION, exchangePerDay: 0.001,
};
