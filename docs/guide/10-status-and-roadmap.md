# 10. Status and what's next

As of 16 October 2026, on `main`, simulation rules `sim_0.38.0`. The Congo forest is the
project. It is fictional and inspired by the Congo Basin. The island is the earlier world and
stays playable.

## Done and verified locally

- **The Congo forest:**
  - **The world:** 48 × 48 km (160 × 160 patches of 300 m, streamed to viewers in 6 km regions),
    with terra firme, flooded and swamp forest, bais, rivers and a seasonal flood.
  - **Thirteen species, about 41,000 animals at founding:**
    - **Duikers and other plant-eaters:** blue, bay and Peters's duikers, the water chevrotain,
      the red river hog, the forest buffalo, the sitatunga, the forest elephant and the agile
      mangabey (which lives mostly in the trees).
    - **Predators:** the African leopard, the African golden cat, the crowned eagle and the
      dwarf crocodile.
  - **Feeding off the roster:** the predators also live on food the world does not hold, at
    measured shares.
- **Ownership, bounties and players:**
  - lives, ownership, control leases, cooldown and respawn, and simulated purchase;
  - sponsor bounties with clues, discovery, attribution, expiry and replay;
  - a tool API, an MCP bridge, an example agent, a store, an inventory and a control panel.

  Money is simulated throughout.
- **A village:** "Forest Landing", fictional with invented names, living by fishing and
  gathering, with no hunting. It is the owner's to change.
- **Behaviour:**
  - each species has an audited set of habits and a persona in the animal panel;
  - hunter and hunted do not drink side by side;
  - fear knows what can take each animal;
  - land animals keep their feet dry;
  - mangabeys rest about 20 m up the canopy tree, eagles perch, and crocodiles lie up under
    the water.
- **The forest view:**
  - **The forest:** photographed bark, leaves and litter; plants and animals at their true
    sizes, with a grass and fern ground cover.
  - **Light and depth:** a bright leaf-green interior lit by day and by moonlight at night,
    tree crowns from above, and a distant forest out to the world's edge.
  - **Animation:** gaits checked against ground speed, and the forest elephant walking on its
    own legs.
  - **The interface:** light frosted panels by default (a dark theme is one tap away). See
    [the before and after](../art-review/congo-2026-10-16/README.md).
- **Speed:** the Congo hour runs well within its 2 s budget, with a median of 0.7 s and a p95
  of about 1.2 s over a simulated year.
- **Operations and quality:**
  - Docker with HTTPS, backup, restore, upgrade and rollback drills;
  - per-visitor limits;
  - a load test of 1000 viewers plus 500 agents on the reference machine;
  - the full regression gate passes with zero skipped tests.

## Open in the ecology

- **Blue duikers** lose about 16% a year in a one-year soak. They held within 1-3% to about day
  200, then fell through the flood quarter and after. Leopards follow the same course, 92 to
  71.
  - Whether this is a seasonal dip or a decline needs a two-year soak (the next measurement;
    `docs/2026-10-13-congo-measurements.md`).
- **Red river hogs** grow about 70% a year, limited only by roots. The same soak shows where
  they level off.
- **Held over the year:** elephants, mangabeys, buffalo and sitatunga.
- **Crocodiles** rose from 375 to about 700 in the first months, then held.

## Open in the forest

- **No flying scavenger:** the Congo has none on its roster. The palm-nut vulture is the
  candidate.

## Still to measure

- Frame time on weaker real devices (phones, older laptops).
- The load test on the real server before raising the default limits.
- The first 24–48 hours on the server, for disk growth, restarts and checkpoint health.

## Needs the owner

- **Production deploy:** a go-ahead, a database backup first, and `VANA_ALLOW_V37_UPGRADE=1`
  for the `sim_0.38.0` upgrade.
- **A server, domain and DNS** for the public site.
- **Arc and money:**
  - the Arc Testnet Memo check;
  - real USDC;
  - legal review before any mainnet.
- **Optional:** an Anthropic API key and a spending limit, to run the Claude player and model
  narration for real.

## Not in this launch

- Posting to X (the X app and keys are the owner's).
