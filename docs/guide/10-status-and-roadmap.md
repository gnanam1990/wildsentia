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
- **The four-year island gate on `island_v2`** passes on seeds 1, 3 and 4 under `sim_0.37.0`;
  seed 2 fails the thirst check only (below). No extinction, no person dies, prey at 66-95% of
  founding after four years.
- **Live agents:** register, take over an animal, move, graze, drink, hunt (predators), climb,
  speak; a published client and an optional Claude player.
- **Operations:** the Docker package with HTTPS, compression and caching; backup and restore,
  upgrade and rollback drills; per-visitor limits and connection caps; internal metrics; a load
  test of 1000 viewers plus 500 agents on the reference machine.
- **Quality:** the full regression gate passes with zero skipped tests, and the browser
  journeys pass against the local stack.

## Open in the ecology

- **Famine litters.** In a hard dry season a starving sow forages far from her nest and her
  piglets die of thirst. No field source was found for wild sows abandoning a litter; the owner
  decides whether these count as care failures.
- **Chital in one seed of four** still fall in the fourth year (11%); three hold or grow.
- **Leopards are few.** Every seed but one breeds leopards, but two of four end with a single
  animal on the closed 26 km² island.
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
