# Congo species behaviour audit, 15 October 2026

Wildsentia's Congo forest is fictional; its animals are modelled on Congo Basin species. This audit compares what each of the 13 species does in the sim with its natural history, and lists the gaps a viewer would notice or that distort the ecology.

**Citations.** S[n] is the source list in `docs/2026-10-13-congo-species-sources.md`. B[n] is the list in `docs/2026-10-14-congo-phase-b-research.md`. "A" marks a value those docs give as an assumption. "General knowledge" marks well-established facts that the repo's sources do not cover.

**Rules that affect every species** (code read on 15 October):
- `escape.freezeFirst` is parsed (`config/loader.ts`) but never read. No animal freezes; `flee()` always runs, climbs or dives.
- Thirst rises at `THIRST_PER_DAY = 0.40` for every species (`agents/drives.ts`); `waterNeedLPerDay` sets only the litres drunk. An animal that gets its water from fruit still walks to water every day or two.
- No species prefers a habitat. Food is chosen by edible kilograms (`perception.ts edibleKg`); `wander()` picks any walkable neighbour. Terrain cost only prices routes.
- Fear ignores size: `threatens()` checks `preferredPrey` and `avoids`, not `maxPreyKg`.
- Herd cohesion aims for `min(3, groupSize[0])` animals per patch (`wander()`).

Already handled, not proposed again: canopy dwelling, no shared drinking, river channels, flood-shy feeding and resting, off-roster diets.

---

## Blue duiker

**Real habits**
- Lives in monogamous pairs, all year, on 2.5–4 ha [S11–S14]. Active by day [S12].
- About ¾ of its diet is fruit, plus browse, fungi and flowers. It gets most of its water from food (A) [S11–S13].
- When alarmed it snorts or whistles, freezes, then dives into dense cover [S12, S13].
- The research doc assumes it listens to mangabey alarm calls (A) [B, §2].

**In the sim now**
- `pairBond: true`, `groupSize [1,2]`. Pairs keep together.
- Diurnal curve; eats `roots` 1.0 (fruit) and browse 0.33.
- `freezeFirst: true` is unused, so it always runs.
- No `heedsAlarmOf`; instead the mangabey heeds the duiker.

**Gaps**
- **High:** It never freezes. Fix: implement `freezeFirst` in `flee()`.
- **High:** It walks to water daily though it barely drinks. Fix: add `diet.preformedWaterShare` 0.8.
- **Medium:** It ignores mangabey alarms. Fix: `social.heedsAlarmOf: ["agile_mangabey"]`.

**Persona — shy.** A small grey-blue antelope, always in twos, picking fallen fruit off the forest floor. It flicks its white tail as it walks. At a sound it goes still, then bolts into the thicket.

## Bay duiker

**Real habits**
- Solitary and nocturnal [S21]. By day it rests hidden in thickets or hollow logs (general knowledge).
- Eats fruit and seeds, plus leaves [S21].
- Escapes by freezing, then crashing into cover (A, as for the blue duiker).

**In the sim now**
- `solitary`, nocturnal curve (1.0 at night, 0.1 by day); `roots` and browse; `freezeFirst` unused.
- It fears crowned eagles and dwarf crocodiles, though an adult (19–21 kg) is above their `maxPreyKg` of 12 and 1.5.

**Gaps**
- **High:** It never freezes (shared fix).
- **Medium:** Adults flee eagles and crocodiles that cannot take them. Fix: limit fear to vigilance (at most 0.3) when the animal is heavier than the predator's `maxPreyKg`. Keep the water-wariness rule as it is.
- **Low:** It drinks daily. Fix: `preformedWaterShare` 0.7.

**Persona — secretive.** A chestnut duiker with a dark stripe down its back. It is seen mostly as eyeshine after dark. Days pass hidden in a tangle; nights are spent nosing for fruit under the trees.

## Peters's duiker

**Real habits**
- Solitary, active by day. One male's range overlaps several females' [S22].
- Eats fruit [S22]. Escapes as other red duikers do (A).

**In the sim now**
- `solitary`, the same diurnal curve as the blue duiker, `roots` plus browse, `freezeFirst` unused.
- It fears eagles and crocodiles that cannot take an adult (17.5–18.5 kg).

**Gaps**
- **High:** It never freezes (shared fix).
- **Medium:** It runs from predators too small to take it (shared fix).
- **Medium:** It ignores mangabey alarms (A). Fix: `heedsAlarmOf: ["agile_mangabey"]`.

**Persona — wary.** A sturdy red duiker that forages alone by day. It keeps its head low and its ears turning. It is more often heard crashing away than seen.

## Water chevrotain

**Real habits**
- Strictly nocturnal, solitary and not territorial [S19].
- Rarely more than 250 m from water, on stream banks and in flooded forest [S18, S19].
- Eats fruit (69%), stems and leaves [S19].
- Freezes first. Then it runs to water, dives for up to about 4 minutes and surfaces under the bank [S19, S20].

**In the sim now**
- Nocturnal curve; `diveSeconds 240`, and the dive escape works. Founded on water-margin patches.
- Then it feeds wherever `roots` are richest: terra firme holds as much fruit as flooded forest (2,200 kg each, `fields/rooting.ts`).

**Gaps**
- **High:** Nothing keeps it near water, so it drifts into dry forest. Fix: add a `habitat` preference weight (flooded and swamp forest 1, terra firme 0.2) to the food and wander choice.
- **Medium:** It never freezes (shared fix).

**Persona — secretive.** A small, hunched, deer-like animal dappled like moonlight on leaves. It shuffles along stream banks at night. When startled it slips into the water and is gone.

## Red river hog

**Real habits**
- Sounders of 6–20 with one boar; gatherings of over 60 [S24, S26]. Mostly nocturnal [S24].
- Omnivore: roots, fruit, fungi, invertebrates and carrion [S24, S26]. A good swimmer [S24].
- Boars defend the sounder and will face a predator (general knowledge).

**In the sim now**
- `omnivore_rooter`, `herd [6,20]`, nocturnal curve. Eats `roots` 1.0, meat 0.2, and scavenges.
- It crosses rivers (`water` cost 2.0) but has no swim escape. Adults flee leopards.

**Gaps**
- **Low:** It always runs. Real boars stand and face a leopard. Fix: a later "mob" response for adult males in a sounder. Not urgent.

**Persona — sociable.** A russet pig with white-tufted ears, never alone. The sounder moves through the night in a grunting line, ploughing the leaf litter for roots and fallen fruit.

## Forest buffalo

**Real habits**
- Stable mixed herds averaging 12 (3–24). Females range over 4.6 km² at Lopé [S27].
- Grazes bais and clearings, with some browse [S27]. Rests in forest cover (general knowledge).
- Leopards take only calves and young. Adults are beyond them [S3, S27].

**In the sim now**
- `herd [3,24]`, grass 0.75, browse 0.25; bais draw it (cost 0.8, 8,000 kg grass).
- No `activity.hourly`: equally active at every hour.
- Adults (270–320 kg) flee leopards because `forest_buffalo` is in the leopard's `preferredPrey`, though `maxPreyKg` is 120.

**Gaps**
- **Medium:** A 300 kg buffalo bolts from a 45 kg leopard. Fix: the same fear rule as the duikers (calves still flee).
- **Low:** It has no daily rhythm. Fix: add an `activity.hourly` with a midday rest (A).

**Persona — imperious.** A compact red-brown buffalo with swept-back horns. The herd lies up in the shade, then files out into the bai to graze. Little in the forest moves it along.

## Sitatunga

**Real habits**
- A swamp specialist. It eats browse, reeds and grasses of marsh and swamp forest [S28].
- Crepuscular. Solitary or in small groups of females [S28].
- An excellent swimmer. When alarmed it sinks until only its nostrils show [S28].

**In the sim now**
- `diveSeconds 120`, water cost 0.8, founded at the water margin.
- Its diet (browse 1.0, grass 0.5) scores terra firme at about 7,900 kg a patch against swamp forest's 4,000, so it drifts onto dry ground.
- Its structure is `pair` with no `pairBond`. It is grouped at founding but has no cohesion.

**Gaps**
- **High:** Nothing keeps it in the swamps. Fix: the habitat preference weight (swamp 1, flooded 0.8, terra firme 0.1).
- **Medium:** It never freezes before plunging (shared fix).
- **Low:** `structure: "pair"` is misleading. Fix: `solitary`, `groupSize [1,3]`.

**Persona — secretive.** A shaggy, long-hoofed antelope that splays its feet across the mud. It browses the reed edges at dusk. When disturbed it wades out and sinks until only its nose shows.

## African golden cat

**Real habits**
- Solitary. Mainly eats rodents (half its prey items in the Ituri; mean prey 1.4 kg). It also takes small duikers and primates [S30, S31].
- Climbs. It overlaps most with the leopard and avoids it [S6].
- No source records it taking adult mangabeys. The research doc has it taking juveniles only (A) [B35].

**In the sim now**
- Prefers blue duikers (1.0); `maxPreyKg 8`, `offRosterShare 0.72`, `avoids: ["african_leopard"]`, climbs from a leopard.
- At 8 kg, an adult female mangabey (6 kg) and a subadult male are within its reach.

**Gaps**
- **Medium:** It can kill adult female mangabeys. Fix: `maxPreyKg` 8 → 5. Blue duikers (4.3–4.8 kg) stay in reach. Recheck kill rates.

**Persona — secretive.** A low, heavy-pawed cat, russet or slate-grey. It is rarely seen except on camera traps. It slips along game trails at dawn and dusk, and goes up a trunk if a leopard is near.

## African leopard

**Real habits**
- Solitary and territorial. Active by day and at dawn and dusk in forest [S2, S7].
- An ambush hunter. Red duikers and red river hogs make up most of what it eats; mean prey is 20–30 kg [S3, S4, S23].
- Rarely caches kills in trees in rainforest [S2, S10].

**In the sim now**
- `territory` 25/80 km², `preferredPreyKg [3,40]`, red river hog 2.0, `cachesKills: false`, `offRosterShare 0.35`, `stalkConcealment 0.8`.

**Gaps**
- No significant gaps. **Low:** leopards do not keep clear of elephants (A) [B, §1].

**Persona — bold.** A dark-rosetted cat that owns its stretch of forest. It walks the trails at first and last light and lies still near feeding hogs. Then it strikes in a few bounds.

## Forest elephant

**Real habits**
- Family units of a mother and her young; Lopé groups held 3–8. Males leave from about 7 years [B1, B6].
- Active day and night. It visits mineral-rich bais often [B9].
- Eats leaves, bark and much fruit: fruit was in 82% of dung piles [B6].

**In the sim now**
- `family [1,8]`. Cohesion aims for `min(3, 1) = 1`, which a lone animal already meets, so adult cows never regroup.
- Its cathemeral curve is good. It eats browse 0.85 and grass 0.15, but no fruit.
- Young males stay in the family group: dispersal leaves the group only for `pairBond` species (`world.ts`).

**Gaps**
- **High:** Families drift apart into single cows. Fix: `social.groupSize` [1,8] → [2,8].
- **Medium:** Young bulls never leave. Fix: in the dispersal branch, males of `family` species leave the group.
- **Low:** Bais draw it only by grass. Fix: a bai "mineral" draw for elephants and buffalo.

**Persona — placid.** A small, round-eared elephant with straight, down-pointing tusks. Families pad through the forest almost silently, stripping leaves and fruit. Now and then they gather at a bai to dig at the mineral soil.

## Agile mangabey

**Real habits**
- Diurnal troops of 7–22 that split and merge [B12, B14, B36].
- Mostly fruit and hard seeds, plus a lot of insects. Spends 12–22% of its time on the ground [B12, B13].
- Escapes cats by climbing and eagles by dropping into dense cover (A) [B, §2]. Gives alarm calls [B, §2].

**In the sim now**
- `canopyDweller`. It rests aloft and comes down at hunger or thirst 0.5, so all its feeding happens on the ground.
- It eats only `browse`, no fruit. `troop [7,22]`, cohesion target 3. `heedsAlarmOf: ["blue_duiker"]`.
- `flee()` climbs from any threat in its patch, eagles included. Up a tree, it is safe from eagles (`canHunt` needs `altitudeM` 0).

**Gaps**
- **Medium:** It climbs from eagles, and eagles cannot reach it. Fix: in `flee()`, a canopy dweller drops to cover from a `raptor`, and `canHunt` lets fliers take prey aloft. Then recheck the eagle's `offRosterShare`.
- **Medium:** It eats leaves and no fruit. Fix: `diet.eats` roots 1.0 and browse 0.33 (foodValue 0.7).
- **Low:** It drinks daily. Fix: `preformedWaterShare` 0.7.

**Persona — sociable.** A slim grey monkey with a dark cap, always in a chattering troop. It sleeps high in the trees and drops to the swampy floor to turn over leaves. At a leopard's scent it barks, and the troop is up the trunks in seconds.

## Crowned eagle

**Real habits**
- Territorial pairs. Nests on emergent trees about 36–52 m up [B25, B27].
- Still-hunts from a perch, then drops onto prey. Most kills are made on the forest floor. It lifts prey to a branch and feeds over days [B25].
- Mostly monkeys, plus small duikers. It needs no open water [B22–B25].

**In the sim now**
- `raptor`, `flies`, `pairBond`, `cachesKills: true`, `offRosterShare 0.94`.
- Every flight lands at altitude 0 (`navigateFlight`), so it rests on the forest floor.
- The hunt approach is walked at `walkMs 0.5 × 0.45` ≈ 0.2 m/s (`encounters.ts`). It flies down to drink.

**Gaps**
- **High:** It rests on the ground. Fix: in `rest()`, a flier perches on its patch's tree anchor (as the canopy roost does).
- **Medium:** It walks up to prey. Fix: a flier's hunt approach uses flight speed and altitude from the perch.
- **Medium:** It drinks. Fix: `preformedWaterShare` 0.95.

**Persona — imperious.** A huge, crested eagle with barred underwings. It sits motionless in an emergent tree for hours, watching. Then it drops through the canopy without a sound.

## Dwarf crocodile

**Real habits**
- Strictly nocturnal. Rests by day in pools, burrows or water [B28, B32].
- Lives in slow, shaded forest streams and swamps. Walks overland on trails at night [B28].
- Eats mostly invertebrates, fish and frogs. No duiker or chevrotain predation is recorded [B28, B29].

**In the sim now**
- Nocturnal curve, `diveSeconds 1800`, `offRosterShare 0.95`, `maxPreyKg 1.5` (newborns only).
- It rests wherever it stops. `wander()` ignores its terra firme cost of 2.5, so it roams dry forest by day.

**Gaps**
- **Medium:** It does not stay by the streams. Fix: the habitat preference weight (swamp, flooded forest and water 1; terra firme 0.1).
- **Medium:** It lies on open ground by day. Fix: in `rest()`, a swimmer with `diveSeconds` of 600 or more rests submerged at the nearest water.

**Persona — placid.** A small, armoured crocodile, dark and knobbly. It lies in a shaded pool by day with only its eyes above the water. At night it plods along the trails, snapping up crabs and frogs.

---

## Top changes

1. **Make freezing real.** In `packages/sim/src/agents/behaviours.ts` `flee()`, act on `escape.freezeFirst`. Blue, bay and Peters's duikers, the water chevrotain and the sitatunga stay still while the threat is not hunting nearby and is outside `flightInitiationM`. They run, dive or climb only once it closes.
2. **Water from food.** Add `diet.preformedWaterShare` to the type, loader and `agents/drives.ts`, scaling `THIRST_PER_DAY` as `offRosterShare` scales hunger. Values (A): blue duiker 0.8, bay and Peters's 0.7, agile mangabey 0.7, crowned eagle 0.95.
3. **Habitat fidelity for wetland species.** Add a `habitat` preference weight to the configs. Use it in `agents/perception.ts` (`edibleKg` and range memory) and in `wander()`. Sitatunga: swamp 1, flooded 0.8, terra firme 0.1. Water chevrotain: flooded and swamp 1, terra firme 0.2. Dwarf crocodile: water, swamp and flooded 1, terra firme 0.1.
4. **Elephant families stay together.** `config/species-congo/forest_elephant.json`: `social.groupSize` [1,8] → [2,8].
5. **The crowned eagle perches.** In `behaviours.ts` `rest()`, a flier settles on its patch's tree anchor, not the ground. Its chick waits there too.
6. **No flight from predators that cannot take you.** In `perception.ts`, when the animal is heavier than the predator's `hunting.maxPreyKg`, cap fear at 0.3 (vigilance only). This covers adult forest buffalo against leopards, and adult bay and Peters's duikers against eagles and crocodiles. The water-wariness rule stays.
7. **Mangabey against eagle.** In `flee()`, a canopy dweller drops to ground cover from a `raptor` instead of climbing. In `canHunt` and `perceive`, a flier may take prey aloft. Then recheck `crowned_eagle.diet.offRosterShare` with a soak.
8. **The eagle attacks from the air.** In `hunt()` (`behaviours.ts`) and `resolveSpatialHunt`, a flier approaches at flight speed with altitude, not at `walkMs 0.5 × 0.45`.
9. **Duikers heed mangabey alarms.** Add `social.heedsAlarmOf: ["agile_mangabey"]` to `blue_duiker.json` and `peters_duiker.json`.
10. **Mangabeys eat fruit.** `agile_mangabey.json` `diet.eats`: roots 1.0 and browse 0.33 (foodValue 0.7).
11. **Golden cats take only juvenile mangabeys.** `african_golden_cat.json` `hunting.maxPreyKg` 8 → 5, then recheck kill rates.
12. **The dwarf crocodile rests in water.** In `rest()`, a swimmer with `diveSeconds` of 600 or more rests submerged at the nearest water by day.
