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
  // sim_0.37.0: 11 per 100 km², inside the 5-15 that Indian reserves with tigers carry.
  leopard: 4,
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
  tiger: 2, dhole: 4, leopard: 2,
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
 * - dhole 5 (sim_0.37.0; 4 before), one pack at the smallest working size of Indian packs (5-12;
 *   Tadoba 6.4 +- 1.3, Bhandari et al. 2021; Bandipur 8.3 adults, Johnsingh 1982): 0.4/km², inside
 *   the 0.35-0.9/km² of Bandipur's core. The founding four lost their breeding female and a helper
 *   in the first litter's second week in two seeds of three. The land in one range holds five
 *   adults (packCapacity: never below the smallest working pack);
 * - leopard 2 (sim_0.37.0), one male and one female: 16/100 km², the top of the 5-15/100 km² that
 *   Indian reserves with tigers carry (Harihar et al. 2011: 9.8 falling to 2.1 as tigers
 *   recovered), as the tiger pair is. One female range (17 km² in Bardia, Odden & Wegge 2005)
 *   covers the island;
 * - jackal 14 (1.1/km², the forest's density; Velavadar held 1-2/km², Moehlman and Jhala 2004).
 */
export const ISLAND_LAND_SHARE = 0.34;
export const ISLAND_POPULATION: Record<string, number> = {
  ...Object.fromEntries(Object.entries(FOREST_POPULATION).map(([id, count]) => [id, Math.max(2, Math.round(count * ISLAND_LAND_SHARE))])),
  tiger: 2, dhole: 5, leopard: 2, jackal: 14,
};

/**
 * sim_0.37.0 `island_v2` founding cohort: the larger island (25.9-26.2 km² of land on seeds 1-3,
 * against 12.2-12.4 for `island_v1`). Prey, the elephant, the vulture and the jackal keep the
 * densities `island_v1` uses: 0.72 of the 36 km² forest's counts (about 39 chital, 12 sambar and
 * 14 wild pig per km²; the jackal's 1.1/km²). The predators are set from field densities on 26 km²:
 * - tiger 3, one male and two females (11.5/100 km²; Nagarahole 11.2 at 56 prey/km² and Kanha 11.5
 *   at 57, Karanth et al. 2004): a male range (60 km²) spans more than one female's (20 km²);
 * - leopard 4, one male and three females (15/100 km²; Mudumalai carries 13/100 km² beside 17.7
 *   tigers/100 km², Kalle et al. 2011, and Yala 12-18 resident adults/100 km², Kittle & Watson 2012).
 *   Female ranges of 11 km² (Odden et al. 2014; Seidensticker 1976: 7 km² in Chitwan) and one
 *   male's range over them (Kittle & Watson 2012: each male's range covers several females').
 *   On `island_v1` every seed's pair ended with one leopard; on `island_v2` three founders lost two
 *   in their first year in one seed of three (a natural death and carrion disease) and died out;
 * - dhole 6, one pack of Tadoba's mean size (6.4 +- 1.3, Bhandari et al. 2021): 0.23/km², the
 *   density of Nagarahole's packs (about 0.2, the soak ceiling's figure) rather than Bandipur's
 *   core. The land in its range holds six adults (packCapacity: 9 x 0.69 land share).
 */
export const ISLAND_V2_LAND_SHARE = 0.72;
export const ISLAND_V2_POPULATION: Record<string, number> = {
  ...Object.fromEntries(Object.entries(FOREST_POPULATION).map(([id, count]) => [id, Math.max(2, Math.round(count * ISLAND_V2_LAND_SHARE))])),
  tiger: 3, dhole: 6, leopard: 4, jackal: 29,
};

/**
 * Congo 1B: the founding population of the 48 km Congo forest (2,304 km²), from the field
 * densities in docs/2026-10-13-congo-species-sources.md:
 * - blue duiker 16/km² (Moukalaba-Doudou, Gabon: 16.4) over terra firme and bais, ~1,730 km²;
 * - water chevrotain 10/km² (7.7-28) along the ~184 km² of flooded forest and river margin;
 * - African leopard 2/100 km², one male to two females. Field densities run 2.7-12.1 (hunted
 *   Gabon forest to Ivindo's core), but there the leopard lives mostly on red duikers and red
 *   river hogs, which the Phase 1 roster lacks. At 6/100 km² the leopards killed ~130 duikers a
 *   day and the duikers fell 15% in 30 days. At 2/100 km² (2.5 kg a day) the 120-day soak still
 *   measured ~37 kills a day (~13,800 a year) while the leopards bred from 46 to 76: about what the
 *   duikers can replace, before their natural deaths. The evidence so far points to a slow
 *   decline; the one-year soak decides. A Phase 1 assumption.
 */
export const CONGO_POPULATION: Record<string, number> = {
  blue_duiker: 27_600, water_chevrotain: 1_840, african_leopard: 46,
};

/** The founding cohort of a closed island, by terrain profile. */
export function islandPopulation(profile: 'island_v1' | 'island_v2'): Record<string, number> {
  return profile === 'island_v2' ? ISLAND_V2_POPULATION : ISLAND_POPULATION;
}

/**
 * The forest is a thirty-six square kilometre window onto a larger one. Animals cross its edge
 * in proportion to how far it is from the density of the country around it (FOREST_POPULATION,
 * the density it was seeded at): a thousandth of the difference a day, both ways.
 */
export const FOREST_LANDSCAPE: NonNullable<WorldOptions['landscape']> = {
  regional: FOREST_POPULATION, exchangePerDay: 0.001,
};
