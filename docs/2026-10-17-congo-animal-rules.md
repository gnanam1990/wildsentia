# Congo animals: the rules of where each one can be (17 October 2026)

The owner asked for every animal to be run and made to behave as it practically would, with the
rules written down. The rules below are checked for every living animal of all thirteen species
at every hour's end, over four simulated days. The test is
`packages/sim/test/animalRules.test.ts`, with the rules in `animalRules.ts`, and it allows no
break.

## The rules

| Rule | What it says |
|---|---|
| `placed` | Every animal stands inside its own patch. |
| `grounded` | An animal that neither flies nor climbs is on the ground, or under water if it dives. |
| `climber-in-tree` | A climber off the ground is up its patch's tree, at the trunk, no higher than it climbs. |
| `bird-perch` | A bird resting off the ground sits on top of a crown (34 m), not inside its leaves. |
| `bird-flight` | A bird in flight is above the canopy, at 55 m or more over the 44 m emergents. Checked along every flight's route in `canopyHeights.test.ts`. |
| `bird-off-floor` | A grown bird is on the forest floor only at a kill, to feed or to drink: it rests and lands in the trees. |
| `dry-feet` | An animal that does not cross rivers keeps out of a river's channel, except to drink at its patch's drinking point and rest there after. Swimmers and the waders that cross rivers (elephant, red river hog) may go in. |
| `diver-in-water` | An animal under water is a diver, in a river channel or a flooded patch. |
| `drinks-at-water` | An animal drinking stands at water: its patch's pool or a river. |
| `canopy-feeding` | Only a canopy dweller feeds up in a tree. |

## Broken before, and how each was fixed

The first run found these breaks over four days. After the fixes there are none.

| Break | Before | Cause | Fix |
|---|---|---|---|
| Crowned eagles resting on the forest floor | 784 of 2,124 rests | Swamp forest had no climbable tree, so no perch for 3-6 km. | Swamp forest has trees to climb and perch in. A resting bird with no tree in its patch flies to the nearest one, up to eight patches out. A bird with nowhere to wander perches. |
| Crowned eagles landing on the forest floor | 1,641 of 3,622 checks | A wandering flight ended on the ground. | In the Congo a wandering bird lands in its destination's tree. |
| Eagles flying through the crowns | flights at 20-25 m | Cruise height came from the bird's flight distance alone. | In the Congo a bird cruises at 55 m or more and comes down through the leaves only to land. |
| Eagles perched inside the leaves | 22 m | A perch was the climbers' height. | A bird lands on top of the crown, at 34 m. |
| Monkeys resting below the crown | 20 m | The canopy tree's limbs are at 23-30 m and its crown at 25-34 m. | Climbers go to 28 m in the Congo's tree, and a mangabey to 26 m, among the limbs. |
| Golden cats, leopards and blue duikers walking in the middle of rivers | 69 times, up to 220 m into a 450 m river | A route passed through each patch at the animal's own spot, which could be in a channel. A channel cut through flooded-forest patches too, not only river patches. | An animal that does not cross rivers goes to a river patch but never through one. On the way it passes a patch a channel touches at that patch's dry point. A step that would cross a channel is closed to it. |
| Eagles landing in rivers | 8 times | A bird's landing spot was never moved to dry ground. | A bird lands on dry ground. A patch that is all river has nowhere to land. |
| Predators finishing a failed chase in the river | leopards and eagles 30-50 m out | A chevrotain dives to escape, and the chase followed it. | For a hunter that does not swim, a chase stops at the bank. A bird whose chase ends over a river is still in the air. |
| Monkeys stacked in one place | up to 17 drawn at one point | The simulation records a troop resting up a tree at that tree's one point. | The view spreads a troop through the crown, each animal in its own place among the branches. |

## Monkeys hold the trees and travel through them

The agile mangabey now lives in the canopy:
- **Resting:** it rests and sleeps up its patch's tree, at 26 m among the limbs.
- **Eating:** hungry, it eats the canopy's fruit and leaves where it sits. If its tree holds too
  little, it crosses to the neighbouring tree with the most.
- **Travelling:** in its active hours its troop moves on through the canopy, tree to tree, about a
  third of the hours. The whole tree's troop goes together, some 1-1.5 km a day.
- **Crossing:** a crossing goes aloft from trunk to trunk between neighbouring patches, never over
  a river's channel.
- **Coming down:** it comes down to drink, and on some hungry hours (15%) to dig for roots and
  fallen seeds.
- **Time aloft:** in a six-day run an independent mangabey spends about 87% of its hours aloft.
  Field studies give 78-88%.
- **On screen:** a crossing is drawn walking along the branches, body level, at canopy height. Its
  life story reads "Moved through the canopy to the next tree". A mangabey resting up a tree is
  drawn sitting out on a limb from the trunk, never inside the trunk. The limb stays drawn when
  the view clears the leaves round a followed animal. An animal chosen from the list is framed
  close up when it loads.

## Getting out of the water

Keeping animals that do not cross rivers out of the channels at first trapped some in them. In a
40-day run 195 animals starved, most of them duikers and buffalo standing in a river. They died
for three reasons:
- **Drinking points far out:** a river patch's drinking point can lie 40-150 m into the channel.
  An animal that walked out there to drink could not step back out, because every step crossed
  water.
- **Food out of reach:** an animal whose way to better food was closed went without eating.
- **Stuck in a saved world:** an animal already far out in a river when a world was saved stayed
  there for good. In the running demo 25 blue duikers stood in rivers, one of them 167 m out, and
  were still there three hours later.

Fixes:
- **Walking out:** an animal standing in a river can always walk out. Water within its first 30 m
  is not a crossing, and neither is water that grows shallower with every step, so it heads for
  the bank, never along or across the river. Once on dry ground, more water is a crossing again.
- **Drinking where it can get back:** an animal that does not cross rivers drinks only at a river
  point within 30 m of the bank. Otherwise it drinks at the forest pools.
- **Eating what is here:** an animal that cannot reach better food eats what is where it stands.

Results:
- **Starvation:** starvation in the 40-day run fell from 195 to 81 with the 30 m wading rule and
  the third fix, to 32 with the second fix, and to 16 once walking out by shallower water was
  added. Only 3 of the 16 died in a river patch; before the fixes, most of the 195 did.
- **Demo world:** after a restart, blue duikers in rivers fell from 25 to 5 in two hours, and
  buffalo from 13 to none.

## Seeing the water

- **Rivers:** every river was drawn facing down. A one-sided surface like that shows only from
  below, so from above the rivers could not be seen. An animal swimming at the surface then looked
  to float in the air, about 3 m over the riverbed, and one wading looked sunk below the bank.
  The rivers now face up. A test checks every river and flood triangle.
- **Camera:** the camera keeps above a river or the flood, as it does above the ground. Before,
  following an animal in a river took the view under the water.
- **Swimmers:** a swimmer rides with its back just under the waterline and its head and neck
  above. With its back at the waterline a sitatunga's head sat in the dark water and only its
  horns showed. One that rests in deep water does it standing, head up, rather than lying down
  out of sight.

## A full-forest audit (18 October)

The rules test runs 40 animals of each species, 520 in all. The owner asked for a full check for
faults like the river ones, so the same rules were run on the whole forest of 41,700 animals,
every hour for four to six days (`packages/sim/test/congoAudit.ts`). The audit also flagged any
animal that said it was travelling but had not moved for 48 hours. It found:

| Found | Over 4 days | Cause | Fix |
|---|---|---|---|
| Elephants and red river hogs in rivers | 71 and 124 checks | Both wade across rivers, but the rule was written for swimmers only. | The rule now applies to animals that do not cross rivers. |
| Duikers and mangabeys grazing in a channel's shallows | 29 checks | Founded in the shallows of a flooded-forest patch, they ate where they stood. | An animal that does not cross rivers, in a channel anywhere but at its drinking point, first walks out to the nearest dry ground it can reach. One that is fleeing flees. A thirsty one goes to its patch's drinking point and drinks, then walks out the next hour. |
| Duikers standing on a river's bank for two days, "travelling" | 16 | In the rains the forest round them was flooded, which a duiker avoids. The only food it knew of was across the river. It chose that food every hour, found no way there, and stood still. | In the Congo, an animal with nothing to eat where it stands, and no food it knows of or only food it cannot reach, goes looking. |
| A leopard scavenging in a river patch | 1 check | It walked to a carcass in the shallows. | Left: a carcass is an endpoint a hunter may step to. |

After the fixes, six days of the whole forest gave:
- **Rule breaks:** 2 checks in 13,243 for leopards, the same leopard. Stalking prey in a river,
  it followed it in, and it walked out within the hour. Every other rule held for every species.
- **Stuck animals:** none.
- **Hour time:** median 1.0 s and 95th percentile 1.5 s over three days; the slowest hour, 2.4 s,
  was the first.

The view was checked as well:
- **A second river facing down:** the island's stored-flow streams (`terrain.ts`) were wound
  facing down too, so no island stream was ever drawn. They now face up. In the Congo they are
  no longer drawn: there they ran patch centre to patch centre and poked blocky slabs out of the
  real river's banks.
- **Far dots under the water:** an animal too far to draw in full is drawn as a dot. A swimmer's
  dot stood on the riverbed, under the water. It now stands on the water.
- **Labels and camera aim:** a swimmer's label, its framing and the camera's aim used the
  riverbed, metres under the animal. They now use the water's surface.
- **Ground:** animals on the ground stand on the drawn ground, at eight places sampled across the
  forest. Monkeys up a tree sit within 1.5 m of the recorded height, spread through the crown.

## Still open

- **Nests:** a crowned eagle's chick, a parent caring for it and a female about to lay stay where
  the family routine puts them, which can be the forest floor. An eagle's nest high in a tree is
  not built yet.
- **Drinking at a river:** a river patch's drinking point can lie 40-150 m inside the channel.
  Animals that do not cross rivers no longer drink there, and swimmers (sitatunga, chevrotain,
  crocodile) and river crossers (elephant, red river hog) do, standing or swimming in the river.
  Moving the point to the bank changes where older recordings say animals drank, so it waits for
  its own change.
- **Leopards stalking into a river:** a chase stops at the bank, but the slow approach before it
  can follow prey a short way into the water. This was seen twice in six days, by one leopard,
  which walked out within the hour.
- **Animals between recorded routes:** the view glides an animal in a straight line from one
  hour's position to the next. Up to 2,048 recorded routes an hour are drawn as walked, which
  covers the animals in view, but one beyond that cap could still be drawn crossing a river.
