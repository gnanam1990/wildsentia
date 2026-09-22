# Vana — The Living Wild

One shared, server-authoritative wildlife simulation. You can watch it. You cannot control it.

- **Design spec:** [`docs/2026-09-22-vana-design.md`](docs/2026-09-22-vana-design.md)
- **M1 plan:** [`docs/superpowers/plans/2026-09-22-vana-m1-simulation-core.md`](docs/superpowers/plans/2026-09-22-vana-m1-simulation-core.md)

## Status

**M1 — simulation core: complete.** Headless, deterministic, nutrient-conserving.
**M2 — shared world: complete.** Runs 24/7, persists to Postgres, survives restart, streams to many viewers.
**M3 — observer client: complete.** A browser renders the live world; every number on screen came off the wire.
**M4 — food web: complete.** Twelve species, predation, scavenging, decomposition, and a closed nutrient cycle.

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
| Tests | 205 across 29 files |

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

export DATABASE_URL=postgres://vana:vana@localhost:5433/vana
npm test                             # full suite, including the 1,000-day soak
npm run typecheck
npm run soak -- --seed 1 --days 1000 # M1 gate
npm run dev:server                   # the live world on :8080
npm run dev:client                   # the observer on :5173
```

Database-backed tests skip themselves when `DATABASE_URL` is unset, so `npm test` still works
without Docker — it simply covers less.

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

## What is not built yet

Reproduction and genetics (M5), so populations decline toward their immigration floors rather than
breeding back. Parental teaching (M6). Thought bubbles and narration (M7). Life replay (M8).
Sign-in accounts are deferred: the `viewers` and `follows` tables exist, but no provider is wired,
and viewer counts work on connection identity alone.

M1 has no reproduction, so the herbivore population declines toward its configured floor and is
held there by off-map immigration. That is expected: M1 proves stability and conservation, not
population dynamics.
