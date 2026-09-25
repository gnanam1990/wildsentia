# Vana — The Living Wild

One shared, server-authoritative wildlife simulation. You can watch it. You cannot control it.

- **Design spec:** [`docs/2026-09-22-vana-design.md`](docs/2026-09-22-vana-design.md)
- **M1 plan:** [`docs/superpowers/plans/2026-09-22-vana-m1-simulation-core.md`](docs/superpowers/plans/2026-09-22-vana-m1-simulation-core.md)

## Status

**Current working tree, 25 September 2026: remaining-build goal active; not launch-complete.**
The latest [household implementation](docs/2026-09-25-community-household.md) adds an opt-in,
checkpointed four-person household, finite-resource construction and a public observer panel.
The [fishing/cooking follow-through](docs/2026-09-25-community-fishing.md) connects local fish
stocks, raw-catch delivery, finite fuel and prepared food (introduced in household rules v2).
The [shared-work increment](docs/2026-09-25-community-learning.md) adds contact/time-bound
cooperation records and observational skill learning in newly founded rules-v3 households;
older saved rules remain unchanged.
The [home-maintenance increment](docs/2026-09-25-community-maintenance.md) adds retained-material
weathering, shelter-dependent sleep and autonomous finite-supply repairs in new rules-v4 worlds.
The [person-history browser](docs/2026-09-25-person-retained-history.md) connects each person's
Community button to checkpoint-pinned older/newer event pages, including retained death records.
The [island cohort check](docs/2026-09-25-island-ecology-water-routing.md) records actual completed
soak days and household outcomes, and fixes thirsty people ignoring delivered home water.
One-year cohorts still expose deprivation requiring review; they are not a full ecology release gate.
The [cross-patch resource journey](docs/2026-09-25-community-resource-journeys.md) gives new rules-v5
households terrain-routed collection/exploration, finite remote food/water/material/fish transfers,
saved travel and retained source records. Older household rules remain pinned. The seed-1 v5
360-day island cohort retained all four people, but animal care warnings and full village scope remain.
The [human character increment](docs/2026-09-25-community-character-rigs.md) connects local CC0
rigs to saved people/tasks, bounded detail, appearance variants and the character review page.
The [v7 household family increment](docs/2026-09-25-community-family.md) records finite-food pregnancies,
persistent children and contact-based childcare, with checkpointed birth/death map actions. The
[micro food-web increment](docs/2026-09-25-micro-foodweb.md) adds conserved fish consumption of
insect/detritivore pools. These are working increments, not completion of the full village or ecology scope.
Fresh v8 households also have [storm, flood, collapse and paid rebuilding](docs/2026-09-25-village-storm-rebuild.md).
[Freshwater fish dispersal](docs/2026-09-25-fish-dispersal.md) and [shore-aware human routes](docs/2026-09-25-shore-routes.md)
advance the ecology and navigation without making them complete.
The [recorded human playback](docs/2026-09-25-community-recorded-playback.md) now connects
actual travelled segments and task/death windows through durable snapshots and the shared
server playback clock to rigs, markers and public person-following. Reduced motion and missing
recordings hold checkpoint positions. Poses remain illustrative; photorealistic/culturally grounded art,
exact work props/contact, historically reconstructed terrain/buildings and broader village scope remain unfinished.
Saved hourly person paths now drive a selected generic 3D rig with explicit gaps in the local client;
this is not a full historical world rewind. Visitors do not
need accounts; the user's launch gate is full agreed functional scope working end to end.

Denser grass,
trees and mixed-size rocks are implemented. Server-owned coordinates and contact-constrained
hunting traces, paired recorded encounters and bounded coordinated live playback are implemented,
but full action coverage, obstacle routing, pack hunting,
production-quality animal art and other product work remain incomplete. The
current fully integrated regression-and-matched-year-tested ruleset is
`sim_0.28.0`; it builds on authoritative contact wounds, finite fish
egg/larval recruitment, langur/squirrel climbing and retained-route replay.
This is **not** browser, biological-calibration or launch acceptance. v0.23→v0.24
adds a narrow parent-opened finite-meat path for dependent tiger cubs.
The prior **v0.28 tested increment** has one anonymous, finite,
insect-visited understorey guild. Flower, modelled visitation, seed and recruit
biomass are conserved and saved separately from generic browse; this does not
identify real bees/plants or establish production ecological realism. See
[v0.28 evidence](docs/2026-09-25-v28-flowering-guild-evidence.md).
Three independent 372-day island + household runs reached the next-year
recruitment window with zero hard failures, and the final isolated PostgreSQL
suite passed 1,225 tests / 174 files. Animal-care warnings, realism,
browser/device performance and the full release gate remain open.
The subsequent [leaf-card LOD and landscape QA pass](docs/2026-09-25-leaf-lod-and-landscape-qa.md)
keeps full photographed foliage close to the camera, halves middle-distance
leaf cards without changing tree placements, and bounds the animal passport
in short mobile-landscape viewports. A sampled local close view fell from
~10.16M to ~7.88M submitted triangles; the final isolated gate passed
1,229 tests / 175 files. This is not mobile-device FPS or art-realism acceptance.
The current source identifies as **`sim_0.29.0`**, a candidate reciprocal
mate-response rule after a two-year v0.28 diagnostic found dhole contact loss.
It is not yet a completed matched-ecology or release gate; see the dated
[two-year diagnostic](docs/2026-09-25-v28-two-year-island-evidence.md).
The [matched v0.24 three-seed gate](docs/2026-09-25-v24-tiger-meat-three-seed-evidence.md)
reports zero dependent tiger starvation in all three one-year fixtures, but one weaned juvenile
tiger still starves and full regression, multi-year and browser acceptance remain separate. The
[v0.23 gate](docs/2026-09-25-v23-tiger-water-three-seed-evidence.md)
showed finite cub drinking but a food-care failure; do not treat a green
soak as release readiness. See the [acceptance ledger](docs/ACTIVE-BUILD-GOAL.md),
[full-scope journey matrix](docs/2026-09-25-launch-journey-matrix.md),
[vegetation evidence](docs/2026-09-23-dense-vegetation.md) and
[encounter evidence](docs/2026-09-23-spatial-encounters.md). The subsequent
[hunt-memory pass](docs/2026-09-23-hunt-memory.md) fixes repeated failed-target loops and adds
species/life-stage diagnostics; capture probabilities are unchanged.
[Paired replay evidence](docs/2026-09-23-paired-replay.md) covers the new controls and separate
local v0.6 preview on port 5177 (not upgraded). The [young-lifecycle pass](docs/2026-09-23-young-lifecycle.md)
adds age-sized needs, bounded parent reserve transfers, orphan ability gates and care provenance.
The [family-contact pass](docs/2026-09-24-family-contact.md) removes dependent teleports and adds
recorded, time-budgeted parental visits and eligible ground-following. The
[hare-nursing pass](docs/2026-09-24-hare-nursing.md) adds scheduled brief care, persistent
rendezvous, independently recorded young/parent arrivals and restart-safe daily intake limits.
Species care calibration, carrying, hiding/den behavior and anatomical nursing animation remain incomplete.
The [CI-readiness pass](docs/2026-09-23-ci-readiness.md) adds `npm run verify:ci` with required
PostgreSQL tests and zero-skipped-test enforcement in its explicit non-soak scope. The GitHub
workflow is implemented and locally checked, not yet pushed or remotely verified.
The [single-writer pass](docs/2026-09-24-single-writer.md) now prevents competing SimHost writers
and migrations on one database, and fails closed when the lock-owning connection is lost.
It requires direct PostgreSQL/session-preserving pooling; full transactional recovery and HA remain open.

### Historical milestone baseline

The M1–M8 labels and measurements below describe earlier, narrower milestones. They are not
acceptance of the expanded backlog or proof that the current rules are balanced or
production-ready. See the dated evidence notes for current runs and unresolved mortality/balance.

**M1 — simulation core: complete.** Headless, deterministic, nutrient-conserving.
**M2 — shared world: complete.** Runs 24/7, persists to Postgres, survives restart, streams to many viewers.
**M3 — observer client: complete.** A browser renders the live world; every number on screen came off the wire.
**M4 — food web: complete.** Twelve species, predation, scavenging, decomposition, and a closed nutrient cycle.
**M5 — reproduction: complete.** Animals are born rather than imported, inherit from two named parents, and age through life stages toward death.
**M5.1 — ecological balance: complete.** The forest regulates itself for five world-years and more: see *Balance*.
**M6 — learning and teaching: complete.** Parents teach their dependent young; raised young outperform orphans.
**M7 — the observer's story: complete.** Passports, planner-grounded thought bubbles, "while you were away" recaps, and optional model narration behind a grounding check.
**M8 — life replay: complete.** Any animal's life replays from its recorded track and moments, five years in two minutes; the log is pruned and the long dead archived so a years-long world fits on a disk.

| Gate | Result |
|---|---|
| 1,000 world-days, no failures | pass (1.09 s wall clock) |
| Nutrient conservation | drift 7×10⁻¹⁰ against a 10⁻² tolerance |
| Determinism across seeds | identical event streams |
| Restart resumes exactly | pass — snapshot carries RNG state |
| Two live clients, identical state | pass |
| Client write attempt | rejected — no write path exists |
| Terrain draw calls | **6** against a budget of 150 |
| Rendered from one batch | 400 patches, 25,472 grass tufts, 2,380 trees |
| Ten world-years, one seed | 29,082,323 events, zero failures, 69 s |
| Hunt success | **23.7%** against a 20–35% target |
| Nutrient drift over ten years | **2.2×10⁻⁸** — through 23,156 deaths and 146,939 scavenger feedings |
| Carcasses returned to soil | 22,837 of 23,156; the rest still decaying |
| Five world-years (long gate), seed 1 | no failures; tiger 4, dhole 9, elephant 10; prey ≥ 60% of seeded |
| Tests | 347 across 45 files |

## Packages

| Package | Responsibility |
|---|---|
| `@vana/shared` | Types, seeded RNG, world clock. Shared by server and client. |
| `@vana/sim` | The authoritative world: patches, fields, agents, events, snapshots. Headless. No network. |
| `@vana/server` | Postgres persistence, the 24/7 sim host, read-only HTTP API, WebSocket gateway. |
| `@vana/client` | three.js observer. Renders server state; simulates nothing. |
| `@vana/runner` | Headless soak runs and validation gates. |

## Commands

For the separate public 30-real-day VPS package, see [deploy/README.md](deploy/README.md).
The root `docker-compose.yml` below is local development only, not a public production setup.

```bash
npm install
docker compose up -d db              # Postgres on :5433

export DATABASE_URL=postgres://vana:vana@localhost:5433/vana            # the live world
export TEST_DATABASE_URL=postgres://vana:vana@localhost:5433/vana_test  # tests truncate this one
npm test                             # full suite, including the one-year soak gate
npm run typecheck
npm run soak -- --seed 1 --days 1000 # M1 gate
VANA_LONG_SOAK=1 npx vitest run soak-long  # five world-years, ~20 minutes
npm run dev:server                   # the live world on :8080
npm run dev:client                   # the observer on :5173
```

Database-backed tests read `TEST_DATABASE_URL`, never `DATABASE_URL`, and refuse any database
whose name does not end in `_test`: they truncate every table, and once pointed at the live
database they wiped the forest's history. Unset, they skip, so `npm test` still works without
Docker — it simply covers less. A fresh `docker compose up` creates `vana_test`; on an existing
volume, run `docker compose exec db psql -U vana -c 'create database vana_test'`.

### The live world

| Endpoint | Returns |
|---|---|
| `GET /world` | clock, season, population, patch count, total nutrients |
| `GET /animals` | every living animal with its drives and current goal |
| `GET /animals/:id` | one animal's live state |
| `GET /animals/:id/events` | that animal's timeline from the event log |
| `GET /events` | the world event feed |
| `GET /patches` | grass, browse, water and soil per patch |
| `WS /live` | world + animals pushed every second; `watch` / `unwatch` for viewer counts |

There is no `POST`, `PUT`, `PATCH` or `DELETE` anywhere. The WebSocket accepts exactly two
messages, `watch` and `unwatch`, and neither touches world state. Viewers cannot change the world
because no code path lets them.

### The observer client

The client holds no simulation. It receives `world` and `animals` frames and renders them:

- **Animation follows state.** `clipForState` maps the server's `state` to an animation clip, so a
  grazing animal plays `Eating` and never a walk cycle. A model with no suitable clip keeps
  playing what it had rather than showing something the server did not say.
- **Movement uses server endpoints.** Agents and carcasses carry authoritative planar coordinates.
  The client interpolates between them; legacy tracks use explicitly approximate patch offsets.
  Recorded paired encounters use one shared timeline with pause/seek controls. Live interpolation
  is not collision-aware. The coarse hourly world update is not continuous global physics.
- **Terrain comes from `GET /patches`.** Elevation, habitat colour, grass density and tree cover
  are all server fields. Trees appear where the simulation reports canopy.
- **The HUD refuses to guess.** A value the server has not reported renders as a dash with the
  tooltip "not reported by the simulation".

## Rules this codebase enforces in tests

- **No `Math.random()` in `@vana/sim`** — runs must replay bit-for-bit.
- **No network client in `@vana/sim`** — the simulation never calls a language model.
- **Nutrients are conserved.** Drift beyond tolerance fails the build.
- **Every significant change emits an event with an id.** Narration without an event id is not possible.

## The food web

Death is not an end state; it is a transfer. An animal that dies becomes a carcass carrying its
own mass, split into muscle, organ, hide and bone. Predators and scavengers take the soft tissue
first, insects and fungi work through the rest, and every gram removed lands in that patch's soil
nutrients — which is what the grass grows from. Decay runs faster in the monsoon than in the dry
season, so *when* an animal died changes how long it is there.

Twelve species run on seven behaviour archetypes, all read from `config/species/`. Which goals an
animal can even consider is decided by its archetype, so a sambar cannot decide to hunt and a
tiger cannot decide to graze, however hungry either gets.

Predation resolves in a pure function from simulation variables alone — concealment, canopy cover,
herd vigilance, stamina, condition, distance at commit. A failed hunt records the stage it reached,
so it can be explained afterwards from the record rather than narrated from imagination.

## Lineage

Every animal born in the world names two parents, inherits six traits as the mid-parent value plus
a bounded mutation, and joins a pedigree that outlives everyone in it. Life stages — newborn,
juvenile, subadult, adult, elder — change intake, escape ability, breeding eligibility and
mortality, not just size. A calf follows its mother until it is weaned and then disperses.

Breeding is gated the whole way: an animal must be a mature adult, in condition, past its
inter-birth interval, and able to find an unrelated partner of the other sex nearby. Courtship can
fail. Close pairings are refused outright, and the offspring of any that slip through carry
depressed disease resistance — which is what makes dispersal worth anything.

Newborn mass is drawn from the patch's soil nutrients, standing for the food the mother converted
during gestation and which the feeding model had already returned there. Nothing is created from
nothing; the ledger stays exact through birth as it does through death.

## Balance

The world is balanced by mechanism, not by tuning a number until the chart looks right. Each
fix below corrected something the model was getting physically wrong:

| Mechanism | Was | Now |
|---|---|---|
| Hunger | A flat drop per meal, so an animal stayed fed on under 2% of its ration | Falls in proportion to `eaten / dailyIntakeKg`; a day's food offsets a day's hunger |
| Feeding hours | Ration spread over 24 hours, implying round-the-clock grazing | Spread over the ~8 hours a grazer actually feeds |
| Gorging | Intake capped near an even trickle, leaving predators permanently hungry | A hungry animal eats up to gut capacity; daily total unchanged |
| Regrowth | `rate × standing crop`, so a grazed-bare patch regrew at nothing | Adds a baseline from root reserves and seed rain |
| Carrion | Found only in patches an animal could see | Found by the carcass's own scent radius |
| Prey density | Seeded at 20 ungulates per km² | Seeded at the ~60 per km² a tiger reserve carries |

The carrion fix mattered most. A dhole fills up in an hour, and with a one-patch view it walked
away from a kill it had barely touched and killed again the next day. Predators were taking five
animals for every one they ate. Letting carcasses be smelt from their scent radius cut kills from
5.7 a day to 2.5 and brought chital back from 30 to 818.

Two world-years, seed 1:

| | before this pass | after |
|---|---|---|
| immigration rescues | 1,372 | **84** |
| kills per day | 5.7 | **2.5** |
| chital | 30 | **818** |
| sambar | 20 | **272** |
| gaur | 10 | **69** |
| langur | 20 | **209** |

### Regulation

The first pass kept the forest alive for two years. Run for five, it emptied in the third:
chital, sambar, langur and boar pinned at their floors, then the tigers starved with them.
Each cause below was measured before it was fixed, and each fix has a test that failed first.

| What was wrong | Evidence | Fix |
|---|---|---|
| Crowding cost hours, not cycles | A crowded hare's courtship failed 95% of the time, yet she conceived in a median 22 hours, against a 132-day cycle | A failed courtship ends that oestrus (`oestrusCycleDays`) |
| Every pack female bred | 12 dholes became 56 in four months | One litter per pack at a time |
| Carrion chosen by size alone | A pack walked between two carcasses as each was eaten down; 205 scavenge decisions a day, 11 reached a carcass | Carcasses are chosen by worth over distance |
| Inter-birth interval counted twice | Config values are birth to birth; gestation was added on top, so chital calved every 17 months, not 10 | Conception opens `interBirthIntervalDays − gestationDays` after a birth |
| Boar data | Two litters a year, 60% of piglets surviving | Field values: one litter, 30-50% survive |
| No tiger ranges | Tigers bred to twelve on 36 km² | Ranges held against the same sex; floaters don't breed and die more often |
| Kills unguarded | Boar ate 67% of every tiger kill, so tigers killed every 2.8 days | Nothing approaches a carcass something that hunts it stands over; now every 5.6 days |
| No prey switching | Tigers kept killing chital at 41 left while boar were everywhere | Prey kind chosen by the square of its abundance |
| Packs unbounded | Dhole packs reached 38 and multiplied | Pack-size cap and pack-against-pack ranges |
| A sealed box | A 36 km² window has no outside to recover from | Animals cross the edge in proportion to the difference from regional density |
| Lakes dried up | Every pool fell to 445 L each dry season; all elephants and 122 gaur died of thirst | Springs and seepage feed lakes and marshes |
| Short sight, no memory | Gaur starved in circles 2 km from pasture | Range memory when nothing in view will do |
| Drinking rationed | Gaur commuted between water and grass until they died | An animal at water drinks its fill |
| Soil never got wet | Drying subtracted the evaporation *fraction* as an absolute amount; soil was bone dry from the first monsoon on, so plants grew at 40% all year and forage fell every year | Moisture recharges with rain and dries in proportion: ~0.9 in the monsoon, ~0.03 at the height of the dry season |

Five world-years, seed 1 (`npm run soak -- --seed 1 --days 1800`):

| | seeded | end of year 5 |
|---|---|---|
| chital | 1,400 | 691 |
| sambar | 450 | 276 |
| gaur | 200 | 144 |
| langur | 300 | 165 |
| boar | 500 | 624 |
| hare | 900 | 1,493 |
| elephant | 8 | 11 |
| tiger | 4 | 7 |
| dhole | 12 | 12 |

No hard failures and no ceiling warnings. 18,584 births against 1,234 arrivals from outside,
six generations, nutrient drift 2.2e-8. Forage now falls to about half in the dry season and
is back above ninety percent by the monsoon's end, every year. The long gate
(`soak-long.test.ts`) checks that no species ends at its floor and every prey species
keeps at least two-fifths of its seeded density.

Starvation over the five years fell from 956 deaths to 63, and no grazer starved at all.

**Still out of band:** vultures. They fall from 25 to 7 over five years, and account for 51
of the 63 starvation deaths.

## What is not built yet

- **Production animal art and movement.** All twelve species now have local model coverage,
  including locally rigged tiger/elephant and stylized langur/squirrel/vulture. Hare uses a rabbit
  approximation. Exact anatomy, foot contact, age/sex variants and full lifecycle motion remain
  unfinished. See `packages/client/public/assets/ASSET-CREDITS.md` and the acceptance ledger.
- **Coordinated physical ecology.** Contact-constrained hunting is a foundation, not completed
  navigation. Obstacles, shoreline contact, pack coordination and synchronized live multi-actor
  playback are pending; the new rules still require extended ecology and release gates.
- **Model narration against the live API.** The narrator is tested end to end with a fake model;
  it has not yet been run with a real `ANTHROPIC_API_KEY`.
- **Visitor accounts are not required.** Removed from scope by the 25 September user decision;
  observation stays open, with browser-local preferences. Admin authorization and reward claim
  wallet-address entry remain separate requirements.
- **Deployment hardening.** Assets are not yet compressed (meshopt/KTX2). A regression workflow
  is implemented with local fresh-install proof; GitHub activation and full release gates remain pending.

### Running an existing world on new code

The last fully integrated regression-and-matched-year-tested ruleset is `sim_0.28.0`.
The current runtime identifies as `sim_0.29.0`; its multi-seed/multi-year and
browser/device acceptance gates are separate from a code regression pass.
Do not upgrade a
saved or preview world without backup, explicit operator choice, and a restore
drill; future in-progress `SIM_VERSION` values are not release approvals.
From day 70, dependent tiger cubs may eat finite
meat only from a carcass their linked living mother previously consumed, after actual
perception, route, contact and feeding time; independent hunting remains locked until
the existing stage gate. This is an uncalibrated model policy under long-run validation.
The prior v0.23 rule let cubs seek and consume finite freshwater from day 70 without
changing weaning or hunting age. In v0.22,
a two-tiger closed island founding cohort starts
with both sexes without adding animals or changing the random stream, and early boar
hydration is bounded by actual maternal-contact arrears and donor reserves. The prior
v0.21 rules let completed carcass meals start persistent,
causally recorded generic illness episodes with delayed symptoms, recovery or disease death.
This model is not species-calibrated medicine or contact transmission. The prior v0.20
deterministic separated inland freshwater basins address
an island-generation case with no perennial lake, while finite freshwater producers and
source-informed young-boar care gates also change future ecology. The prior v0.17 rules made thirsty household members
return to delivered home water before withdrawing and drinking it, instead of repeatedly selecting
a depleted external source.
The v0.19 seed-1 one-year cohort had no boar starvation or dehydration, but all four founding
elephants died of adult dehydration by day 210 because that island had no inland lake. A
v0.20 360-day basin candidate kept all four elephants and all 12 species alive with zero
hard failures; nine orphan/unweaned boar starved, four newborn boar dehydrated, and other
young-dehydration warnings remain. The matched v0.21 seed-1 one-year run also exited 0
with all 12 species and four elephants; it recorded 15 carrion-illness episodes, all 15
symptomatic and recovered with no disease death. It also recorded eight orphan boar
starvation deaths and 16 boar young dehydration deaths, four while a parent was alive.
That care signal motivated the separately versioned v0.22 contact rule. Three matched
v0.22 island+household seeds completed 360 days with all 12 species and no hard
failures, but young-animal dehydration and multi-year/realism gates remain open; do not
promote this build or upgrade the existing preview based on a short or invariant-only run.
Three matched v0.23 years also completed, and the tiger's finite direct-water path is
proven in an exact seed-2 trace. Tiger-cub dehydration disappeared in these fixtures,
but 3/2/1 juveniles in seeds 1/2/3 starved with a living parent, so dependent-food
care remains open and this is not a release gate.
Three matched v0.24 years also completed without hard invariant failure. Their
dependent tiger starvation counts fell to zero in seeds 1–3, but seed 3 still has
one weaned-juvenile starvation death; see the [v0.24 evidence](docs/2026-09-25-v24-tiger-meat-three-seed-evidence.md).
Three matched v0.25 years also completed without hard invariant failure. Saved
langur/squirrel tree routes and selected historical replay passed the isolated
regression gate; langur predation/population shifts vary sharply by seed, so this
is not a claim that the climbing policy improves wild survival. See the
[v0.25 evidence](docs/2026-09-25-v25-tree-climb-three-seed-evidence.md).
The subsequent v0.26 contact-wound rules also completed [three matched island
years](docs/2026-09-25-v26-wound-three-seed-evidence.md), with recorded injury,
infection and healing milestones. The later [v0.27 finite fish recruitment
gate](docs/2026-09-25-v27-fish-three-seed-evidence.md) records spawned, hatched
and recruited population-level cohorts in all three matched years and a current-tree
1,197-test isolated PostgreSQL regression, including the wound-upgrade guard.
These scenario wound and fish rates are not species-calibrated field estimates,
and the existing preview was not upgraded.
This includes v0.16 recorded mate travel and end-of-tick contact, fixing patch-only breeding
teleports that could prevent six-hour life tracks from saving; the v0.15 shared island
heightfield/closed-population profile; and earlier conserved
drainage, pack food delivery and family travel. See [courtship/startup evidence](docs/2026-09-24-courtship-contact.md)
and [hydrology scope](docs/2026-09-24-surface-drainage.md). Main river/channel geometry,
larger fully integrated communities, realistic animal art and complete ecological balance remain pending.
A mismatched snapshot refuses to boot by default. Do not
truncate an existing world's history. Use a fresh isolated database for evaluation, or follow
an explicit version-specific upgrade path only after its database tests pass in your environment:

1. Stop the world's writer; back up the **entire** database and verify a restore to a separate
   database. Retain the old code/config with that backup.
2. Test migrations and upgrade on the restored copy first. Migration 005 adds nullable encounter
   traces; migration 006 adds nullable ordinary movement traces; migration 010 stores recorded
   human movement only after this code executes it. None fabricate paths for old events.
3. For a validated `sim_0.5.0` copy use `VANA_ALLOW_V5_UPGRADE=1`; for `sim_0.6.0` use the separate
   `VANA_ALLOW_V6_UPGRADE=1`; for `sim_0.7.0` use `VANA_ALLOW_V7_UPGRADE=1`;
   for `sim_0.8.0` use `VANA_ALLOW_V8_UPGRADE=1`;
   for `sim_0.9.0` use `VANA_ALLOW_V9_UPGRADE=1`;
   for `sim_0.10.0` use `VANA_ALLOW_V10_UPGRADE=1`;
   for `sim_0.11.0` use `VANA_ALLOW_V11_UPGRADE=1`;
   for `sim_0.12.0` use `VANA_ALLOW_V12_UPGRADE=1`;
   for `sim_0.13.0` use `VANA_ALLOW_V13_UPGRADE=1`;
   for `sim_0.14.0` use `VANA_ALLOW_V14_UPGRADE=1`;
   for `sim_0.15.0` use `VANA_ALLOW_V15_UPGRADE=1`;
   for `sim_0.16.0` use `VANA_ALLOW_V16_UPGRADE=1`;
   for `sim_0.17.0` use `VANA_ALLOW_V17_UPGRADE=1`;
   for `sim_0.18.0` use `VANA_ALLOW_V18_UPGRADE=1`;
   for `sim_0.19.0` use `VANA_ALLOW_V19_UPGRADE=1`;
   for `sim_0.20.0` use `VANA_ALLOW_V20_UPGRADE=1`;
   for `sim_0.21.0` use `VANA_ALLOW_V21_UPGRADE=1`;
   for `sim_0.22.0` use `VANA_ALLOW_V22_UPGRADE=1`;
   for `sim_0.23.0` use `VANA_ALLOW_V23_UPGRADE=1`;
   for `sim_0.24.0` use `VANA_ALLOW_V24_UPGRADE=1` only after a full backup,
   explicit operator approval and a staging restore drill.
   for `sim_0.25.0` use `VANA_ALLOW_V25_UPGRADE=1` only after the same gates
   when the wound ruleset is accepted; for `sim_0.26.0` use
   `VANA_ALLOW_V26_UPGRADE=1` only after the same gates for the v0.27 finite
   freshwater fish-cohort ruleset. No old save gains historical eggs or larvae.
   For an actual `sim_0.27.0` checkpoint, `VANA_ALLOW_V27_UPGRADE=1` opts into
   v0.28 flowering rules only after a copied checkpoint, backup and restore drill.
   It preserves any saved fish cohort and divides existing eligible browse at
   the upgrade boundary without inventing past blooms, visits or seeds.
   For an actual `sim_0.28.0` checkpoint, `VANA_ALLOW_V28_UPGRADE=1` opts into
   the v0.29 reciprocal mate-response rule after the same backup/restore gate.
   It preserves the checkpoint, flowering/fish cohorts and RNG exactly;
   only future animal decisions change.
   Each flag accepts only its exact source version, preserves state/RNG, records an explicit
   rules-upgrade event and saves a current-version checkpoint. **A flag authorizes
   a jump from that saved version to the current runtime, including all intervening
   rule changes; it is not a single-version incremental migration.** Review every
   intervening change before setting it. A v0.24 upgrade
   does not lift, move or protect a ground animal retroactively. A v0.23 upgrade does not feed,
   move or reroll an existing tiger cub. A v0.22 upgrade does not hydrate,
   move or reroll an existing tiger cub. A v0.20 upgrade does not invent
   historical illness; a v0.21 upgrade gives existing young boar no retroactive water
   credit and does not rewrite an existing island's founder sexes. Older micro-ecology checkpoints receive
   zero historical aquatic-producer biomass, then future growth pays from soil. On island saves,
   explicit upgrade promotes deterministic land patches to freshwater habitat without granting
   historical water; existing water stays in place and displaced vegetation returns to soil.
   The v0.16 path
   preserves household stocks,
   in-flight tasks, deaths and clocks; it changes future decisions, not recorded history.
   The v0.15 path refuses a living animal's
   inconsistent patch/position instead of guessing a historical repair; review recovery separately.
   Future behavior intentionally changes;
   older source versions also opt into all intervening rules changes.
4. Unset the flag after the upgrade. Same-version restarts need no opt-in. For rollback, use the
   full backup with matching old code: rolling snapshot retention is **not** a permanent backup.

This upgrade has not been applied to the existing local preview. Its current serving status
was not verified in this increment; a green client build does not establish a server upgrade.
