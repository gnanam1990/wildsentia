# Congo forest: first measurements, 13 October 2026

These are the measurements for sub-project 1A of the Congo Phase 1 design. The budget is from §1 of [the spec](superpowers/specs/2026-10-13-congo-phase1-design.md): one world hour of the Congo founding population in 2 s or less.

## How it was measured

- **Command:** `npm run bench:congo -w @vana/runner` (`packages/runner/src/congoBench.ts`).
- **CI check:** `packages/runner/test/congoBench.test.ts` steps the full stand-in population for 3 hours, in about 8 s, and fails if any hour takes over 2 s. A slower host may set `VANA_CONGO_HOUR_BUDGET_MS`.
- **World:** a `congo_v1` world, seed 7, 48 × 48 km (160 × 160 patches of 300 m), terrain `congo_terrain_v1`.
- **Founders:** these measurements used stand-ins from the island roster, before the Congo species existed. Since 1B, `bench:congo` founds the real Congo species (see the 1B section below).

  | Stand-in | Count | Standing in for |
  |---|---|---|
  | `hare` | 45,000 | small forest prey |
  | `chital` | 3,000 | larger prey along water |
  | `leopard` | 150 | the predator |

- **Run:** 24 world hours to settle, then 24 world hours timed one by one.
- **Machine:** Apple M4, 10 cores, 16 GB, Node 22.23.1. The sim runs on a single thread.

## Results

| Measure | Value |
|---|---|
| Living animals after 48 h | 47,909 |
| Founding the world | 1.25 s |
| One world hour, median | 849 ms |
| One world hour, 95th percentile | 890 ms |
| One world hour, slowest of 24 | 892 ms |
| **2 s budget** | **held** |
| JS heap after the run | 340 MB |
| Peak resident memory | 966 MB |
| Snapshot, as one JSON string | 77 MB |
| Snapshot serialisation | 536 ms |
| Whole run, 48 world hours plus founding | 44.8 s |

For comparison, the 36 km² mainland forest steps 4,048 animals in 84 ms per world hour. The Congo world has 12× the animals and 64× the patches, and takes about 10× as long.

## What this means for Plan 1A.3

- **The budget holds without optimisation.** At 12 world hours per real hour a step comes every 300 s, and the step takes under 1 s.
- **The step still blocks the main thread.** At about 0.85 s per step, every viewer and agent would stall for most of a second every five minutes. The worker step (spec §1) is still needed, but to keep the server responsive, not to meet the budget.
- **The snapshot is large.** One 77 MB JSON value takes over half a second to build, and more to write. The per-region snapshot chunks (spec §1) are needed.
- **Two slow paths will matter once agents use the map:**
  - the sim's route planner (`planRoute`) sorts its whole queue at every step;
  - the live layer's route search (`landRoute`) scans its open set linearly.

  Both are fine at 400 patches. Across 25,600 patches a long route will be slow, so both should use a binary heap.
- **This is only the first 48 hours.** Populations, carcasses and hunting change over weeks. The 30-day Congo soak in sub-project 1B repeats these measurements with the real Congo species.

## The server never stalls (plan 1A.3, 13 October)

The world now steps, and checkpoints, in slices. Between slices the server answers viewers and agents, and commands that would change the world wait with `503 world_busy`. These timings are from the Congo stand-in world (about 48,000 animals), measured inside the full sim test suite:

| Work | Slices | 99th percentile | Longest |
|---|---|---|---|
| One world hour | 767 per hour | 6 ms | 40 ms |
| Copying the checkpoint | 250 records each | 4 ms | 18 ms |
| Serializing the checkpoint (77 MB) | 1,000 records each | 21 ms | 46 ms |

Before this, the step held the server for about 850 ms and the checkpoint for about 900 ms (copy plus `JSON.stringify`). The server's default slice is 25 ms (`sliceMs`).

**Route search** was measured and left alone:
- **Animal routes** (sim `planRoute`): corner to corner across the map takes 71 ms with the old sorted queue, and animals route only a few patches at a time.
- **Live-layer routes** (`landRoute`): about 1 ms, because every Congo patch can be walked, so routes run straight.

## The Congo species on their own (sub-project 1B, 13 October)

**Setup:** seed 7, the full founding population (27,600 blue duikers, 1,840 water chevrotains, African leopards), measured with `DAYS=n npm exec -w @vana/runner tsx src/congoSoak.ts`.

| | 30 days, leopards at 6/100 km² (138) | 120 days, leopards at 2/100 km² (46), 2.5 kg/day |
|---|---|---|
| Blue duikers alive | 23,341 | 22,013 |
| Water chevrotains alive | 1,683 | 1,578 |
| African leopards alive | 126 | 76 (born: gestation 96 days) |
| Duikers killed | 3,968 | 4,439 |
| Chevrotains killed | 143 | 168 |
| Successful dives | 945 | 453 |
| Non-swimmers in mid-river | 2 (before the chase fix) | 0 |
| Mean condition, duiker / chevrotain | 0.97 / 0.97 | 0.95 / 0.95 |
| One world hour, p95 / max | 864 / 1,514 ms | 868 / 1,340 ms |

**What this shows**
- **The two runs differ in three ways,** not one: leopard density (6 → 2 per 100 km²), intake (3.0 → 2.5 kg a day), and the chase fix that keeps animals out of the deep river.
- **Over-predation at field density.** At 6/100 km² the leopards killed about 130 duikers a day, and the duikers fell 15% in a month. In real Congo forests most of a leopard's food is red duikers and red river hogs, which the Phase 1 roster lacks.
- **Below the field range.** 2/100 km² is under the 2.7–12.1 measured in Gabon and Congo forests. It is a Phase 1 assumption, and leopards kill about 37 a day at that density.
- **Probably still too many leopards.** About 37 kills a day is about 13,800 a year, roughly what duikers can replace before their natural deaths, and the leopards are breeding (46 → 76). So the evidence points to a slow decline unless the one-year soak shows births catching up.
- **Duikers still decline at first.** They lose about 20% over 120 days, before their first births. A blue duiker's gestation is 207 days, so the first young of the founding pairs arrive around day 207.
- **Balance is not yet shown.** Predation against births can only be judged over a year or more, and the leopards are also breeding. The one-year soak is the next measurement.
- **The budget holds.** Every hour stayed under 2 s.

**One year (360 days, leopards at 2/100 km², 2.5 kg/day).**
- **Alive at the end:** 17,384 blue duikers (−37%), 1,528 water chevrotains (−17%) and 33 leopards.
- **Leopards rose, then fell.** They bred from 46 to about 76 by day 120, then fell to 33.
- **Kills:** 12,427 duikers and 568 chevrotains.
- **Dives:** 591.
- **Stranded in mid-river:** none.
- **Condition:** duikers 0.93, chevrotains 0.93.
- **One world hour:** p95 822 ms, max 1,502 ms. The run overlapped a test-suite run for its last half hour.

So the forest neither collapses nor holds steady in its first year. Prey and predators decline together, which suggests the leopards are food-limited. Duiker births arrive only after day 207. Whether the populations settle in the second year is not yet measured. Tuning them is a Phase 2 question, with the missing prey (red duikers and red river hogs) added.

## The Congo forest in the browser (plan 1A.4, 13 October)

**Setup:** a local Congo server (`VANA_TERRAIN_PROFILE=congo_v1`, seed 7, its own local database) and the Vite client, in the desktop app's browser pane: 1138 × 994 px, device pixel ratio 1, graphics on Auto (it chose *balanced*). World time Day 2, 10–11 am, monsoon.

| | |
|---|---|
| Scene for one region (20 × 20 patches, ~470 animals) | 642 KB of JSON, 83 KB deflated |
| Scene for four regions (a view across a region corner) | 2.7 MB of JSON, 342 KB deflated |
| A scene arriving after a `view` message | 13 ms for the first; 0.73 s for a switch to four regions |
| The camera crossing into a new region, to new ground drawn | 0.81 s (when the 10 s switching rule allows it) |
| `/regions/:id`, eight regions fetched one after another | 2.7 MB in 98 ms |
| Frame rate: aerial view, in a bai, 25 m from the ground in forest | 75, 75, 75 fps (the pane's refresh rate) |
| JavaScript heap | 194 MB |

Screenshots: [flooded forest in the monsoon](2026-10-13-congo-screens/flooded-forest-monsoon.jpg), [the flood from the air](2026-10-13-congo-screens/aerial-flood.jpg), [the river](2026-10-13-congo-screens/river.jpg), [a bai](2026-10-13-congo-screens/bai.jpg).

**What the running build found.** Each is now fixed with a test that failed first:
- **The ground kept the old region.** The browser redrew terrain only on a new checkpoint, so a region switch within the hour moved the animals and left the ground behind.
- **A far corner loaded first.** Before the first scene, the camera sat at its default spot (0, 0) and told the server so; the server loaded region r0_0, then switched back 10 s later.
- **No trees.** Each patch's trees were planned from the island's centre with a 4.5 km reach, so nothing was planted 24 km away.
- **The server stopped stepping at 1 pm on day 1.** The tracks table's position check (migration 004) bounded positions to the 6 km island. Migration 026 widens it to the 48 km forest, `not valid`, so startup does not scan the table.
- **No flood reached the browser.** Neither patch view sent `flooded` or `deepWater`.
- **Flood water was buried.** Each flood plane stood 0.5 m above its patch's centre, while the ground in a patch varies by up to 20 m. The water also did not redraw when the forest flooded or drained.
- **The Congo ground was untinted tan.** The tint textures were sized for the island's 20 × 20 patches and skipped every Congo patch; one shader program also shared the island's 6 km span.

**Still temporary.**
- **The canopy is too open.** The forest uses the island's plant mixes and a budget of about 300 trees a patch, far fewer than a rainforest's.
- **Water edges are square.** Rivers and floods are drawn one 300 m square at a time, which shows from the air.
- **Placeholder models.** The species are on the temporary rigs, labelled so in the model status.

## Balancing the Congo food web (14 October 2026)

One-year soaks, seed 7, the full founding population (`SEED=7 DAYS=365 SOAK_PROGRESS=1 npx tsx packages/runner/src/congoSoak.ts`),
counts at day 365 (founding in brackets).

| Run | Blue duiker | Bay / Peters's | Red river hog | Golden cat | Leopard |
|---|---|---|---|---|---|
| 2A as built (18,000) | 4,339 (−76%) | 3,125 / 3,115 | 3,310 | 94 | 57; rose to 179 by day 180, then crashed |
| + founders across their breeding cycle | stopped at day 150: 12,931 | 4,174 / 4,253 | 2,920 | 128 | 102 |
| + food from beyond the roster | 11,888 (−34%) | 4,102 / 4,208 | 3,636 | 164 | 76; no boom |

- **Founders across their breeding cycle.** In the first run every founding female was receptive at once. The leopards bred in lockstep and no duiker was born before day 207. Founders are now drawn somewhere in their inter-birth interval, already pregnant when within a gestation of the next birth.
- **Food from beyond the roster.** The cats had been eating their whole diet as the nine simulated species. Their hunger now falls on those species only for the share of food the world holds (`diet.offRosterShare`). The leopard's is 0.35 and the golden cat's 0.6; sources are in `docs/2026-10-13-congo-species-sources.md`.
- **Phase B and the attribution soak.** The new species were added: forest elephant, agile mangabey, crowned eagle and dwarf crocodile. A 60-day soak then counted kills by predator. In 60 days predators took about 3,400 blue duikers, against about 1,800 born:

  | Blue duikers taken | Count |
  |---|---|
  | Eagles | 1,455 |
  | Golden cats | 1,009 |
  | Leopards | 893 |
  | Crocodiles | 58 |

  Eagles took 251 of the 2,500 mangabeys. Two causes:
  - The eagles killed about twice the share of simulated prey that their diet implies.
  - The 2A budget had halved the blue duikers to 7.8/km², below their cited 16/km².

  The fix:
  - Blue duikers up to 22,000 (12.7/km²). That is as many as the 2 s hour holds; 27,000 took a median 1.69 s and a worst 2.16 s.
  - The eagle's off-roster share calibrated to its kill rate (0.92), with lower preferences for mangabeys and blue duikers.
  - Eagles at one pair per 15 km² (307).
  - Mangabeys also founded on terra firme at 0.5/km², to 3,300.

  At about 41,000 animals the hour's median is 1.13 s and its worst 1.28 s. The one-year soak of this tuned web follows below.
- **One year with mangabeys in the trees (seed 7, 14 October).** Mangabeys now rest and sleep up their trees, out of reach of the planar hunt solver. The eagles then turned to duikers. Two one-year soaks:

  | Run | Blue duiker | Bay / Peters's | Mangabey | Leopard | Golden cat | Eagle | Red river hog |
  |---|---|---|---|---|---|---|---|
  | Start | 22,000 | 4,600 / 4,600 | 3,300 | 92 | 140 | 307 | 2,300 |
  | Canopy, diets as before | 11,761 (−47%) | 4,208 / 4,229 | 2,827 | 68 | 161 | 266 | 3,775 |
  | + diets calibrated | 18,108 (−18%) | 4,474 / 4,508 | 3,243 | 72 | 175 | 252 | 3,916 |

  - Before calibration, predators took 14,061 blue duikers a year: golden cats 5,550, leopards 4,273, eagles 4,086. A golden cat took about 35 a year, twice its diet's share.
  - The world holds 12.7 blue duikers per km², at the low end of what Central African forests hold, while the predators are at real densities. Off-roster shares are therefore calibrated to kill rates: leopard 0.3 → 0.45 (it also eats duikers the world does not hold), golden cat 0.6 → 0.85, eagle 0.92 → 0.97. Predators then took 8,108 blue duikers a year: leopards 4,218, golden cats 2,161, eagles 1,582.
  - Still drifting after calibration:
    - Blue duikers held to day 180 (21,258) and then fell about 600 a month in the second half.
    - Leopards fell from 92 to 72, 37 of them starved. Eagles fell from 307 to 252, 62 of them in territorial fights.
    - Red river hogs grew 70% and were still growing; predators took 322 a year.
    - Golden cats rose 25%.
  - Mangabeys held (−2%). An independent mangabey spends about 75% of its hours aloft.
  - The hour's p95 was 1.75 s and its maximum 3.75 s, on a machine shared with other work.
- **Hour cost.** Under the founders and diet fixes the hour's p95 was 1.58 s and its maximum 5.6 s. That run shared the machine with the CI gate and two other soaks; the budget benchmark run alone stays under 2 s.
