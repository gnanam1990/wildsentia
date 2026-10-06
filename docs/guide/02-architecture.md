# 2. Architecture

## Packages

The repository is a TypeScript monorepo (Node 22, npm workspaces):

| Package | Responsibility |
|---|---|
| `packages/shared` (`@vana/shared`) | Types shared by every side: world positions, encounter and movement traces, the seeded random generator, the world clock, presentation pacing. |
| `packages/sim` (`@vana/sim`) | The authoritative world: patches, plants, water, soil, animals, people, events and snapshots. Headless, deterministic, no network. |
| `packages/server` (`@vana/server`) | Runs the world around the clock, stores it in PostgreSQL, serves the read-only HTTP API and the `/live` WebSocket, and runs the live-agent layer. |
| `packages/client` (`@vana/client`) | The three.js observer. Renders what the server reports; simulates nothing. |
| `packages/runner` (`@vana/runner`) | Headless soak runs and the ecology gates. |

Species are data, not code: each is a JSON file in [`config/species/`](../../config/species).
(The `@vana/*` package names and `VANA_*` settings are internal names kept from the project's
first name; the product is Wildsentia.)

## The shape of the system

```
            ┌──────────────────────────── server ────────────────────────────┐
 species    │  SimHost (one writer)                                          │
 config ───▶│   ├─ World.step(1 hour) ── events ──▶ PostgreSQL (events)       │
            │   ├─ checkpoint each hour ─────────▶ PostgreSQL (snapshots)    │
            │   ├─ recorded hour (routes, hunts) ─▶ live frame               │
            │   └─ live layer, 10 Hz (agents' animals)                       │
            │  HTTP API /api/* (read-only for visitors)                      │
            │  WebSocket /live ── scene, world, animals, live roster ──┐     │
            └──────────────────────────────────────────────────────────│─────┘
                                     Caddy (HTTPS, compression)        │
                                                                       ▼
                         browser: observer client (three.js) plays the recorded hour
```

### The hourly world step

`SimHost` owns the only `World` and runs every change through one serial queue, so there is
exactly one writer. A database lock enforces the same across processes: a second server on the
same database refuses to start, and a server that loses its lock connection stops.

Each scheduled tick advances the world by one hour. During that hour animals decide what to do
(by need: food, water, rest, safety, mates, young), move along routes across the terrain,
graze, drink, hunt, flee, give birth and die. Every significant change is appended to the event
log with an id. Each animal's route through the hour and every hunt are recorded as traces
(positions with timestamps).

After the step, the world is saved as a **checkpoint**: a full snapshot including the random
generator's state, stored with its simulation version. A restart restores the latest checkpoint
and carries on exactly where it stopped. A hard crash loses at most the work since the last
checkpoint.

### Simulation versions and upgrades

Every snapshot carries the simulation version that wrote it (for example `sim_0.35.0`). When
the rules change, the version changes. A server never silently moves a saved world onto new
rules: it refuses to load an older snapshot unless an explicit, one-time upgrade flag is set for
that saved version (`VANA_ALLOW_V34_UPGRADE=1` moves a `sim_0.34.0` world onto current code).
Upgraded worlds keep their history. See [8. Deploying and operating](08-deploy-and-operate.md).

### Serving

- The **HTTP API** under `/api` is read-only for visitors: the world clock, animals, patches,
  life stories, recorded hunts and routes, the event map, the village. Agents have their own
  signed endpoints. See [6. API reference](06-api.md).
- The **`/live` WebSocket** pushes the current scene: the world clock and weather, the living
  animals, and the recorded hour that browsers play (its routes and hunts). Large scenes are sent
  when a checkpoint or recording changes, with small keepalives in between, and large messages
  negotiate compression. A viewer can send which animal it is watching and which part of the
  island its camera covers, and nothing else.
- **Caddy** terminates HTTPS, compresses JS, CSS, JSON and models (zstd or gzip), and serves the
  built client with long-lived caching for hashed files.

## How a browser plays an hour

The browser receives the recorded hour and plays it through, in step with every other viewer:

1. **Routes are paced to real speed.** At 12× a recorded walk would race across the screen.
   Pacing ([`packages/shared/src/pacing.ts`](../../packages/shared/src/pacing.ts)) keeps every
   recorded position and its order but spends the hour's idle time on movement, so each animal
   walks at its species' real pace. An hour holding more movement than fits plays proportionally
   faster, and the animal is shown running.
2. **Hunts share one timeline.** Predator and prey are sampled at the same instant. A chase
   plays at sprinting pace; a predator's hold on its prey plays in real time.
3. **Between hours** the client interpolates from each animal's last position to its new one.
4. **Close to the camera, animals get full 3D models** within a render budget; farther ones are
   drawn as lightweight dots. Bodies are kept clear of each other, of people, of tree trunks and
   rocks, and out of pools, for presentation only.
5. **Animation follows the recorded state and the ground speed.** See
   [4. The observer](04-observer.md#how-animals-are-animated).

## The live-agent layer

When live agents are enabled (`VANA_LIVE_AGENTS=1`), a second loop runs at 10 Hz beside the
hourly ecology. It moves the animals agents control, at most their species' speed per tick, on
land, and applies grazing, drinking and resting through the same world rules. Before each hourly
step those positions are written into the world, so food, water and predators all see where
those animals really are; the hourly step still applies their metabolism, ageing, illness and
death. The layer saves agents and their animals every 10 seconds and on shutdown. See
[5. Live agents](05-live-agents.md).
