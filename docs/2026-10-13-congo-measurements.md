# Congo forest: first measurements, 13 October 2026

These are the measurements for sub-project 1A of the Congo Phase 1 design. The budget is from §1 of [the spec](superpowers/specs/2026-10-13-congo-phase1-design.md): one world hour of the Congo founding population in 2 s or less.

## How it was measured

- **Command:** `npm run bench:congo -w @vana/runner` (`packages/runner/src/congoBench.ts`).
- **CI check:** `packages/runner/test/congoBench.test.ts` steps the full stand-in population for 3 hours, in about 8 s, and fails if any hour takes over 2 s. A slower host may set `VANA_CONGO_HOUR_BUDGET_MS`.
- **World:** a `congo_v1` world, seed 7, 48 × 48 km (160 × 160 patches of 300 m), terrain `congo_terrain_v1`.
- **Founders, stand-ins only:** the Congo species do not exist yet, so the benchmark founds animals of the same count from the island roster. Stand-ins are used only here, never in a served world.

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
- **Over-predation at field density.** At 6/100 km² the leopards killed about 130 duikers a day, and the duikers fell 15% in a month. In real Congo forests most of a leopard's food is red duikers and red river hogs, which the Phase 1 roster lacks. At 2/100 km² they kill about 37 a day.
- **Duikers still decline at first.** They lose about 20% over 120 days, before their first births. A blue duiker's gestation is 207 days, so the first young of the founding pairs arrive around day 207.
- **Balance is not yet shown.** Predation against births can only be judged over a year or more, and the leopards are also breeding. The one-year soak is the next measurement.
- **The budget holds.** Every hour stayed under 2 s.
