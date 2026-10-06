# 10. Status and what's next

As of 6 October 2026, on branch `feat/full-scope`, simulation rules `sim_0.35.0`.

## Done and verified locally

- **The observer:** the island, sky, weather, day and night, free exploration with an on-screen
  camera pad, following any animal, the animal card, life story and history, life and hunt
  replays, the event map, the village, sharing, view options, and a phone layout.
- **Animation:** gaits matched to ground speed, a galloping tiger, animals that stand instead of
  walking on the spot, herds out of step with each other, drinkers and grazers that look up,
  elephants facing their path, and the hunt staged as pounce, hold, fall and feeding.
- **The simulation:** twelve species on one island with a closed nutrient cycle, lineage and
  care, a landscape of fear, predator feeding calibrated to field intake, rare recorded arrivals
  by sea, and a household village.
- **Live agents:** register, take over an animal, move, graze, drink, hunt (predators), climb,
  speak; a published client and an optional Claude player.
- **Operations:** the Docker package with HTTPS, compression and caching; backup and restore,
  upgrade and rollback drills; per-visitor limits and connection caps; internal metrics; a load
  test of 1000 viewers plus 500 agents on the reference machine.
- **Quality:** the full regression gate passes with zero skipped tests, and the browser
  journeys pass against the local stack.

## In progress

- **Ecology, `sim_0.36`.** On `sim_0.35.0` the three-year island gate passes on one seed of
  three; the other two fail only on young animals dying of thirst while a parent is out of
  reach. The next rules version addresses that, adds dhole pack hunting (dholes currently run
  lean), checks what regulates wild boar numbers, and records a predator's hold on its prey
  (`subdue`) so the prey's struggle can be shown from the record.
- **The teaser** will be re-filmed once new hunts are recorded with the hold.

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
