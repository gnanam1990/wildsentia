# 3. The simulation

The simulation (`packages/sim`) is the whole truth of the world. It is headless, deterministic
and conserves nutrients. The live server runs the `island_v1` terrain with the `household_v1`
village; the current rules are **`sim_0.35.0`**.

## The island

- A 20 × 20 grid of 300 m patches (6 × 6 km), with an island of about 12 km² of land surrounded
  by sea. Each patch has a habitat, elevation, canopy cover, grass, browse (shrubs and leaves),
  soil nutrients and, where there is one, a water access point (a pool).
- Positions are exact planar coordinates in metres, not just patch numbers, so animals walk
  real routes round water and sea.
- Seasons drive growth and rain: the monsoon greens the island and speeds decay; the dry season
  thins forage and shrinks water.
- Smaller life is modelled as finite pools: an understorey flowering guild with visitation and
  seed recruitment, insects and detritivores, and fish in the pools.

## Species

Twelve species run on seven behaviour archetypes, all defined in
[`config/species/`](../../config/species). The archetype decides which goals an animal can
consider at all: a sambar cannot decide to hunt and a tiger cannot decide to graze, however
hungry either gets.

| Species | Archetype | Adult mass | Shoulder | Walk / sprint (m/s) |
|---|---|---|---|---|
| Tiger | apex predator | 190 kg | 1.0 m | 1.3 / 15 |
| Dhole | pack predator | 17 kg | 0.5 m | 1.4 / 13 |
| Golden jackal | omnivore | 9 kg | 0.45 m | 1.2 / 12 |
| Wild boar | omnivore | 75 kg | 0.85 m | 1.1 / 11 |
| Chital | herd grazer | 70 kg | 0.9 m | 1.2 / 12.5 |
| Sambar | herd grazer | 220 kg | 1.35 m | 1.1 / 11 |
| Hare | herd grazer | 2.5 kg | 0.22 m | 0.8 / 16 |
| Gaur | mega-herbivore | 850 kg | 1.7 m | 1.0 / 9 |
| Asian elephant | mega-herbivore | 3,200 kg | 2.7 m | 1.2 / 6.5 |
| Grey langur | arboreal troop | 13 kg | 0.6 m | 1.0 / 8 |
| Giant squirrel | arboreal troop | 2 kg | 0.25 m | 0.9 / 7 |
| White-rumped vulture | scavenger (flies) | 5.5 kg | 0.8 m | 0.6 / 18 |

## Needs and decisions

Each animal has drives (hunger, thirst, fatigue, fear) that rise and fall with what it does.
Each hour it picks a goal from those its archetype allows: find food, find water, rest, flee,
hunt, scavenge, court, care for young, follow a parent. It then moves to act on it, at its
species' speed and across the terrain, so food and water have to be reached, not wished for.

## The food web and nutrients

Death is a transfer, not an end. A dead animal becomes a carcass carrying its own mass, split
into muscle, organs, hide and bone. Predators and scavengers take the soft tissue first;
insects and fungi work through the rest; every gram removed lands in that patch's soil, which
is what the plants grow from. Decay runs faster in the monsoon. The nutrient balance is checked
continuously: drift beyond tolerance fails the build.

## Lineage, life stages and care

- Every animal born names two parents and inherits six traits, as the mid-parent value plus a
  bounded mutation. The pedigree outlives everyone in it.
- Life stages (newborn, juvenile, subadult, adult, elder) change intake, escape ability,
  breeding and mortality, not just size.
- Parents care for their young through recorded contact: nursing, provisioning (a tigress
  opens a carcass for her cubs) and visits. Young follow their mother on the ground; nothing
  teleports. Parents also teach skills, and raised young outperform orphans.
- Births carry the population. The island receives only rare, recorded arrivals of animals
  that swim ashore (tiger, elephant, jackal), each written to a ledger.

## Hunting

A hunt is resolved spatially, from simulation variables alone: the hunter's concealment and
the canopy, herd vigilance, both animals' stamina and condition, the distance at which the
hunter commits, the terrain, and the land boundary. It is recorded as a trace of predator and
prey positions through its phases:

`approach` → `stalk` → `chase` → `contact` (and, from `sim_0.36`, a recorded `subdue` hold
until the prey dies) — or `escape` / `abandon` when it fails.

A failed hunt records the stage it reached, so it can be explained afterwards from the record.
On the current rules a tiger succeeds in about one hunt in five, a dhole in about one in nine.

**Feeding is calibrated to field intake** (`sim_0.35.0`). A kill fills the predator's stomach
(a tiger holds about 27 kg, matching the 18–35 kg a tiger eats at one sitting). The stomach is
digested over the following days, and a predator does not hunt while it is sated or below its
hunting hunger. A lone tiger among plentiful deer makes about 48 kills a year, about 8 days
apart, against about 50 a year at 7–8-day intervals in the field (Karanth & Sunquist). There is
no kill cap anywhere: kill rates emerge from intake, satiety, carcass use and hunt success.

## Fear

Prey live in a landscape of fear (`sim_0.34.0`). They detect and avoid the predators that hunt
them (a stalking tiger is noticed at about 45 m), flee a spotted hunter in the same hour, and
chital and langur respond to each other's alarm calls.

## The village

A small household lives on the island (opt-in rules, saved with the world). People gather
food, water, timber and fibre, fish and cook, build and repair their home, weather storms and
floods, cooperate on shared work, learn skills by watching, and raise children. Their travelled
paths and tasks are recorded and played back like the animals'.

## How the ecology is tested

| Gate | What it checks |
|---|---|
| Unit and integration tests | Rules, conservation, determinism, checkpoints and upgrades (part of `npm run verify:ci`) |
| Mainland 360-day gate | A full world-year without hard failures |
| Island 3-seed × 3-year gate | 1,080 days on three seeds: every day completes, no species goes extinct, nutrients are conserved, births carry the population, and no dependent young dies of thirst while its living parent is out of reach |

Long gates run on request (`VANA_LONG_SOAK=1 … npx vitest run soak-long`; see
[`docs/2026-10-05-multi-year-ecology.md`](../2026-10-05-multi-year-ecology.md) for the method,
the before-and-after numbers and the sources). Current status is in
[10. Status and what's next](10-status-and-roadmap.md).
