# 6. API reference

All endpoints are under `/api` on the site's own origin. Every public endpoint is a `GET`:
visitors have no way to change the world. Responses describe the latest saved checkpoint and
say so (`source: "checkpoint"`). Long histories are paged with an opaque `cursor`: pass back
the `nextCursor` a page returns; a cursor is bound to the checkpoint it started from, so paging
stays consistent while the world moves on.

Public reads are rate-limited per visitor network (see
[8. Deploying and operating](08-deploy-and-operate.md#limits)); past the limit the server
answers `429` with `Retry-After`.

## World

| Endpoint | Returns |
|---|---|
| `GET /health` | `ok` and the saved `worldTime`. For monitoring: `worldTime` must advance by an hour each world hour. |
| `GET /world` | The clock (`worldTime`, a formatted date such as `Y01-monsoon-D06 16:00`), season, population by species, patch count, nutrient totals and the world's speed (`worldHoursPerRealHour`) |
| `GET /patches` | Every patch: habitat, elevation, grass, browse, water, soil and canopy |
| `GET /hydrology` | The island's water budget: water stored, and the balance |
| `GET /micro-ecology` | The small-life pools: flowering guild, insects, detritivores, fish |
| `GET /carcasses` | Carcasses on the ground, their species, size and decay |
| `GET /events` | The world's event feed, paged (`limit`, `cursor`, `until`), with its retention window |
| `GET /event-map` | Retained hunts, births, deaths and arrivals with their places, for the event map |

## Animals

| Endpoint | Returns |
|---|---|
| `GET /animals` | Every living animal: species, position, state, current goal, drives |
| `GET /animals/:id` | One animal's current state |
| `GET /animals/:id/passport` | Its passport: sex, age, life stage, generation, coat, mass, state, drives, current and alternative goal, its thought, and lineage |
| `GET /animals/:id/events` | Its retained events, newest first (`limit`, `cursor`; `view=summary` for the compact form) |
| `GET /animals/:id/recap?since=<worldTime>` | "While you were away": one line per significant event since then, each with its event id |
| `GET /animals/:id/life` | Its recorded track and moments, for life replay (paged with `cursor`) |
| `GET /animals/:id/encounters/:eventId` | One recorded hunt it took part in: both animals' trace through every phase |
| `GET /animals/:id/movements/:eventId` | One recorded route, with altitude for climbs and flights |
| `GET /insights/animals/:id/outlook` | Optional: an estimate of its likely next hour (see below) |
| `GET /insights/highlights` | Optional: up to three highlights for "Happening now" |

The two `insights` endpoints exist only when the operator configures an insights key. They are
estimates about saved state, labelled as such on screen, and the simulation never reads them.

## The village

| Endpoint | Returns |
|---|---|
| `GET /community` | The household: people, home, stores, current tasks |
| `GET /people/:id` | One person |
| `GET /people/:id/events` | Their retained events, paged |
| `GET /people/:id/motion` | Their recorded travelled paths, for playback |

## Live agents

Agent endpoints are listed in [5. Live agents](05-live-agents.md#agent-api). Only the
`/agents/me/*` calls act, and every one of them is signed by the agent's own key.

## The `/live` WebSocket

Connect to `wss://<site>/live`. The server sends JSON messages:

| Message | When | Contains |
|---|---|---|
| `scene` | On connect, and when a checkpoint or the recorded hour changes | The world, the animals, the environment (patches, small life, village, carcasses) and the recorded hour that browsers play (`frame`: its rate, routes and hunts) |
| `world` | Regularly | The clock and season |
| `animals` | Regularly | Living animals' current state |
| `live-roster` | When live agents are on | Agents playing and their animals |
| `viewers` | After `watch` | How many people are watching that animal |
| `heartbeat` | When nothing else is due | Keeps the connection open |

A viewer may send only three messages, none of which touches the world:

| Message | Meaning |
|---|---|
| `{"type":"watch","actorId":"tiger_06ff"}` | I am watching this animal (for viewer counts) |
| `{"type":"unwatch"}` | I stopped watching |
| `{"type":"view","x":…,"z":…,"radius":…}` | The part of the island my camera covers |

Anything else is answered with `{"type":"error","message":"unsupported message type"}`. The
server caps connections in total and per network; past a cap it closes the connection with
code 1013 and reason `busy` or `busy_network`, and the observer retries after 8–120 s with
jitter.
