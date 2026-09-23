# Vana — The Living Wild

One shared, server-authoritative wildlife simulation. You can watch it. You cannot control it.

- **Design spec:** [`docs/2026-09-22-vana-design.md`](docs/2026-09-22-vana-design.md)
- **M1 plan:** [`docs/superpowers/plans/2026-09-22-vana-m1-simulation-core.md`](docs/superpowers/plans/2026-09-22-vana-m1-simulation-core.md)

## Status

**M1 — simulation core: complete.** Headless, deterministic, nutrient-conserving.
**M2 — shared world: complete.** Runs 24/7, persists to Postgres, survives restart, streams to many viewers.
**M3 — observer client: complete.** A browser renders the live world; every number on screen came off the wire.
**M4 — food web: complete.** Twelve species, predation, scavenging, decomposition, and a closed nutrient cycle.
**M5 — reproduction: complete.** Animals are born rather than imported, inherit from two named parents, and age through life stages toward death.
**M5.1 — ecological balance.** Every species now persists on its own births. Immigration fell from 1,372 rescues to 84 over two world-years.

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
| Tests | 234 across 31 files |

## Packages

| Package | Responsibility |
|---|---|
| `@vana/shared` | Types, seeded RNG, world clock. Shared by server and client. |
| `@vana/sim` | The authoritative world: patches, fields, agents, events, snapshots. Headless. No network. |
| `@vana/server` | Postgres persistence, the 24/7 sim host, read-only HTTP API, WebSocket gateway. |
| `@vana/client` | three.js observer. Renders server state; simulates nothing. |
| `@vana/runner` | Headless soak runs and validation gates. |

## Commands

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
- **Movement is interpolation, not invention.** The simulation's spatial resolution is the 300 m
  patch. Each animal gets a stable offset inside its patch and eases between patch centres over
  the real duration of a hop. The client never places an animal somewhere the server did not put it.
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

Five world-years, seed 1 (`npm run soak -- --seed 1 --days 1800`):

| | seeded | end of year 5 |
|---|---|---|
| chital | 1,400 | 672 |
| sambar | 450 | 228 |
| gaur | 200 | 130 |
| langur | 300 | 184 |
| boar | 500 | 671 |
| hare | 900 | 1,442 |
| elephant | 8 | 6 |
| tiger | 4 | 3 |
| dhole | 12 | 13 |

No hard failures and no ceiling warnings. 17,872 births against 1,668 arrivals from outside,
six generations, mean inbreeding 0.003, nutrient drift 1.9e-8. The long gate
(`soak-long.test.ts`) checks that no species ends at its floor and every prey species
keeps at least two-fifths of its seeded density.

**Still out of band:** hunger is still a killer in the dry season. Over the five years 339
sambar, 262 gaur, 257 chital and 29 elephants starved; for sambar that is close to its
births (368). The late dry season runs short of grass for everything grazing at once. Some
of that is how a real dry season goes, but at this scale it is the next thing to fix.

## What is not built yet

Parental teaching (M6) — the dependency period exists here precisely so that M6 has somewhere to
put it. Thought bubbles and narration (M7). Life replay (M8). Sign-in accounts are deferred: the `viewers` and `follows` tables exist, but no provider is wired,
and viewer counts work on connection identity alone.

M1 has no reproduction, so the herbivore population declines toward its configured floor and is
held there by off-map immigration. That is expected: M1 proves stability and conservation, not
population dynamics.
