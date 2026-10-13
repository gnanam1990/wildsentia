# Congo forest: first measurements, 13 October 2026

These are the measurements for sub-project 1A of the Congo Phase 1 design. The budget is from §1 of [the spec](superpowers/specs/2026-10-13-congo-phase1-design.md): one world hour of the Congo founding population in 2 s or less.

## How it was measured

- **Command:** `npm run bench:congo -w @vana/runner` (`packages/runner/src/congoBench.ts`).
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
