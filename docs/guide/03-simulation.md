# 3. The simulation

The simulation (`packages/sim`) is the whole truth of the world. It is headless, deterministic
and conserves nutrients. The live server runs the `island_v1` terrain with the `household_v1`
village; the current rules are **`sim_0.37.0`**.

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

Thirteen species run on seven behaviour archetypes, all defined in
[`config/species/`](../../config/species). The archetype decides which goals an animal can
consider at all: a sambar cannot decide to hunt and a tiger cannot decide to graze, however
hungry either gets.

| Species | Archetype | Adult mass | Shoulder | Walk / sprint (m/s) |
|---|---|---|---|---|
| Tiger | apex predator | 190 kg | 1.0 m | 1.3 / 15 |
| Leopard | apex predator (climbs) | 58 kg male, 34 kg female | 0.7 m | 1.0 / 16.1 |
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
- Litters stay together (`sim_0.36.0`): young too small to walk gather to the sibling their
  mother is feeding and do not scatter when she is attacked; langur infants are carried;
  leverets are nursed from birth. Each species' following and foraging ages are in its config.
- Births carry the population. The island receives only rare, recorded arrivals of animals
  that swim ashore (tiger, elephant, jackal), each written to a ledger. Leopards are not among
  them: no sea crossing by a leopard is documented. A world saved before `sim_0.37.0` gains its
  leopard pair the same way, as a recorded arrival when it is upgraded.
- **Wild boar are limited by food** (`sim_0.37.0`). Each land patch holds a finite rooting and
  mast food (roots, tubers, soil invertebrates, fallen fruit and seed) that regrows from the soil
  and that boar dig out first. Grass and leaves are worth half to three-fifths of that food, and
  its gut takes under two days' food a day, so on green forage alone a pig just holds its own
  (van Wieren 2000: pigs live on grass only while it is low in fibre). A sow's breeding and
  litter size follow her body condition, the share of her need met by roots and mast over the
  past month (Servanty et al. 2009; Bergqvist et al. 2018: about one more piglet per 16 kg of
  sow), and a hungry sow has less milk for her piglets. Nothing caps their number.

## Hunting

A hunt is resolved spatially, from simulation variables alone: the hunter's concealment and
the canopy, herd vigilance, both animals' stamina and condition, the distance at which the
hunter commits, the terrain, and the land boundary. It is recorded as a trace of predator and
prey positions through its phases:

`approach` → `stalk` → `chase` → `contact` → `subdue` (the hold until the prey dies) — or
`escape` / `abandon` when it fails.

**The kill is a hold, not a touch** (`sim_0.36.0`). After contact the predator holds the prey
(by the throat or nape) and the prey drags a little, until it dies at the end of the hold. A
tiger holds small prey for seconds and large prey for one to four minutes; a dhole pack takes
longer, shared among the hunters. Large prey sometimes break free from a tiger and escape,
possibly wounded. Hunts recorded before `sim_0.36.0` have no hold: their prey died at contact.

A failed hunt records the stage it reached, so it can be explained afterwards from the record.
On the current rules a tiger succeeds in about one hunt in five.

**Leopards** (`sim_0.37.0`) are ambush cats of 34-58 kg. They prefer prey of 10-40 kg (Hayward
et al. 2006): a piglet before the sow, a fawn before the stag, and no prey over 100 kg. They do
not spend their hunts on hares while deer are in view. A leopard kills about
once every six days, as in Bardia (one kill every 5.6 days, Odden & Wegge 2009), and holds a
chital by the throat for one to three minutes. Where its patch has a tree it caches the kill in
it, out of reach of everything but itself and its cubs (Balme et al. 2017), and a mother hunts
for her weaned cubs as well as herself.

**Leopards keep away from tigers.** A leopard treats a tiger as prey treat a predator: it detects
it, keeps out of its patch, does not hunt or range where it stands unless starving, keeps off a
carcass the tiger is holding, flees it, and climbs the patch's tree when the tiger is beside it
(Odden et al. 2010; Harihar et al. 2011). Tigers killing leopards is recorded in the field only
anecdotally, and in the model tigers do not hunt them.

**Dholes hunt as a pack** (`sim_0.36.0`). The island is founded with one pack of five
(`sim_0.37.0`), the smallest working pack (wild packs run 5-12; Tadoba 6.4, Bhandari et al.
2021), and its land holds five adults. For the first two months after a litter the mother stays
at the den and the pack feeds her there (Johnsingh 1982); she hunts again only if her hunger
becomes desperate. A dhole with packmates out of reach goes to them before it hunts, rather than
hunting alone. Packmates within reach join a hunt, each adding to
its chance, and all feed at the kill; weaned pups follow, and helpers carry food to the den.
Prey choice follows field data: sambar are favoured, pigs and langur avoided, and a pack goes
for prey of 30–235 kg unless it is starving. Dholes succeed in about three hunts in ten (one in
seven to one in six under `sim_0.36.0`, when helpers often hunted alone).

**Feeding is calibrated to field intake** (`sim_0.35.0`). A kill fills the predator's stomach
(a tiger holds about 27 kg, matching the 18–35 kg a tiger eats at one sitting). The stomach is
digested over the following days, and a predator does not hunt while it is sated or below its
hunting hunger. A lone tiger among plentiful deer makes about 50–56 kills a year, roughly a
week apart, against about 50 a year at 7–8-day intervals in the field (Karanth & Sunquist).
There is no kill cap anywhere: kill rates emerge from intake, satiety, carcass use and hunt
success.

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
| Island 3-seed × 3-year gate | 1,080 days on three seeds: every day completes, none of the thirteen species goes extinct, all six people live, every prey species stays above a quarter of its founding count, nutrients are conserved, births carry the population, and no dependent young dies of thirst while its living parent is out of reach |

Long gates run on request (`VANA_LONG_SOAK=1 … npx vitest run soak-long`; see
[`docs/2026-10-05-multi-year-ecology.md`](../2026-10-05-multi-year-ecology.md) for the method,
the before-and-after numbers and the sources). Current status is in
[10. Status and what's next](10-status-and-roadmap.md).

**On `sim_0.37.0` the island gate fails in every seed.** The dhole pack now holds and boar settle
at 6-14 per km², but three large predators on 12 km² eat the deer faster than they breed: chital
end the third year at 5%, 10% and 28% of their founding count, the tigers die out in one seed, and
every seed ends with a single leopard. The ecology doc sets out why and the owner's options.
