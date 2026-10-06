# 10. Status and what's next

As of 7 October 2026, on branch `feat/full-scope`, simulation rules `sim_0.37.0`.

## Done and verified locally

- **The observer:** the island, sky, weather, day and night, free exploration with an on-screen
  camera pad, following any animal, the animal card, life story and history, life and hunt
  replays, the event map, the village, sharing, view options, and a phone layout.
- **Animation:** gaits matched to ground speed, a galloping tiger, animals that stand instead of
  walking on the spot, herds out of step with each other, drinkers and grazers that look up,
  elephants facing their path, and the hunt staged as pounce, hold, fall and feeding.
- **The simulation:** thirteen species, the leopard among them, on one island with a
  closed nutrient cycle, lineage and care, a landscape of fear, predator feeding calibrated to
  field intake, dhole pack hunting with a den mother, food-limited wild boar, kills recorded as a
  hold, rare recorded arrivals by sea, and a household village. New worlds use `island_v2`, about
  26 km² of land (`island_v1` had about 12).
- **The three-year island gate** last passed on all three seeds under `sim_0.36.0`. Under
  `sim_0.37.0` on `island_v2` seed 1 passes; seeds 2 and 3 fail only the thirst check, one
  litter each (below). No extinction, all people alive, prey above the floor (lowest 30-39%).
- **Live agents:** register, take over an animal, move, graze, drink, hunt (predators), climb,
  speak; a published client and an optional Claude player.
- **Operations:** the Docker package with HTTPS, compression and caching; backup and restore,
  upgrade and rollback drills; per-visitor limits and connection caps; internal metrics; a load
  test of 1000 viewers plus 500 agents on the reference machine.
- **Quality:** the full regression gate passes with zero skipped tests, and the browser
  journeys pass against the local stack.

## Open in the ecology

- **Two litters still die of thirst away from their mother** on the gate: piglets of a starving
  sow in the dry season, and leverets whose mother hunting dholes kept away at their evening
  feed. Dholes hunt by day in the field, and the model has no daily activity cycle; that is the
  candidate fix.
- **Chital still decline** on `island_v2`, to 30-39% of founding by the third year, against
  three predators at field densities on a closed 26 km² island. A measured chital
  recruitment rate is the missing check.
- **Leopards are few.** Every seed breeds leopards, but one ends the third year with a single
  animal.
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
