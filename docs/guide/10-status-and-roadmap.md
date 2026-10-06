# 10. Status and what's next

As of 6 October 2026, on branch `feat/full-scope`, simulation rules `sim_0.36.0`.

## Done and verified locally

- **The observer:** the island, sky, weather, day and night, free exploration with an on-screen
  camera pad, following any animal, the animal card, life story and history, life and hunt
  replays, the event map, the village, sharing, view options, and a phone layout.
- **Animation:** gaits matched to ground speed, a galloping tiger, animals that stand instead of
  walking on the spot, herds out of step with each other, drinkers and grazers that look up,
  elephants facing their path, and the hunt staged as pounce, hold, fall and feeding.
- **The simulation:** twelve species on one island with a closed nutrient cycle, lineage and
  care, a landscape of fear, predator feeding calibrated to field intake, dhole pack hunting,
  kills recorded as a hold, rare recorded arrivals by sea, and a household village.
- **The three-year island gate passes on all three seeds** (`sim_0.36.0`): no extinction, all
  people alive, prey above the floor (lowest 39–55% of founding), and no young dead of thirst or
  hunger beside a living parent.
- **Live agents:** register, take over an animal, move, graze, drink, hunt (predators), climb,
  speak; a published client and an optional Claude player.
- **Operations:** the Docker package with HTTPS, compression and caching; backup and restore,
  upgrade and rollback drills; per-visitor limits and connection caps; internal metrics; a load
  test of 1000 viewers plus 500 agents on the reference machine.
- **Quality:** the full regression gate passes with zero skipped tests, and the browser
  journeys pass against the local stack.

## Open in the ecology

- **The dhole pack is fragile.** On two of three seeds the founding pack loses its mother and a
  helper soon after the first litter, and a single dhole lives on. A larger founding pack, or a
  den mother that stays and is fed, are the candidate fixes.
- **Wild boar are too many.** They end at two to three times their founding numbers, far above
  field densities. Piglet survival now matches field data; what is missing is the leopard and a
  food limit on pigs.
- Results vary from run to run; one intermediate run collapsed into famine. Long gates are run
  on several seeds for this reason.

## Next

- **The teaser** will be re-filmed with a newly recorded hunt, so the prey's struggle in the
  hold is shown from the record.

## Still to measure

- Frame time on weaker real devices (phones, older laptops).
- The load test on the real server before raising the default limits.
- The first 24–48 hours on the server, for disk growth, restarts and checkpoint health.

## Needs the owner

- **A server, domain and DNS** for the public site.
- **Optional:** an Anthropic API key and a spending limit, to run the Claude player and model
  narration for real.

## Not in this launch

- Posting to X.
