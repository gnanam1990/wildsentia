# 7. Running it locally

## Requirements

- Node.js 22 or newer
- Docker with Docker Compose (on macOS, Docker Desktop or Colima)
- For the full test gate: a PostgreSQL database whose name ends in `_test`
- Optional: Blender 5 for model work, ffmpeg and Python 3 with Pillow for video

## Quick start for development

```bash
npm install
docker compose up -d db                     # PostgreSQL on :5433 (local development only)

export DATABASE_URL=postgres://vana:vana@localhost:5433/vana
export TEST_DATABASE_URL=postgres://vana:vana@localhost:5433/vana_test

npm run dev:server                          # the live world and API on :8080
npm run dev:client                          # the observer on :5173
```

The root `docker-compose.yml` uses a known password and is for local development only; never
expose it. Database tests read only `TEST_DATABASE_URL` and refuse any database whose name does
not end in `_test`, because they truncate every table. On an existing volume, create the test
database once with `docker compose exec db psql -U vana -c 'create database vana_test'`.

## Tests

```bash
npm test                 # the whole suite
npm run typecheck
npm run verify:ci        # the full regression gate (below)
```

**The full gate** (`npm run verify:ci`) type-checks every package, runs every test against the
isolated `_test` database, builds the client, and fails if any test is skipped. It ends with:

```
Regression gate passed: <N> tests, zero skips. Ecology/release gates are separate.
```

Run it before every commit that is meant to ship. If your shell has no UTF-8 locale, set
`LC_ALL=en_US.UTF-8` first; PostgreSQL needs it.

**Ecology gates** are long and run on request:

```bash
npm run soak -- --seed 1 --days 1000                         # quick headless run
VANA_LONG_SOAK=1 npx vitest run soak-long                    # the mainland multi-year gate
VANA_LONG_SOAK=1 VANA_LONG_SOAK_TERRAIN=island_v1 VANA_LONG_SOAK_DAYS=1080 \
  VANA_LONG_SOAK_SEEDS=1 VANA_LONG_SOAK_OUTPUT=.ci-artifacts/multi-year \
  npx vitest run soak-long                                   # one island seed, three years
```

Run one process per seed. A three-year island seed takes roughly half an hour on a fast
machine. Method and current results:
[`docs/2026-10-05-multi-year-ecology.md`](../2026-10-05-multi-year-ecology.md).

## The local end-to-end stack

`tools/e2e/stack.sh` builds and runs the same containers as the server package (database,
server, web with Caddy) from your checkout, on <http://localhost:28080>:

```bash
tools/e2e/stack.sh up          # build and start
tools/e2e/stack.sh rebuild     # rebuild after code changes; the world and its database persist
tools/e2e/stack.sh logs
tools/e2e/stack.sh down        # stop (the world is kept)
```

Its secrets live in a private file outside the repository (`~/.vana-e2e.env` by default,
created on first use). The stack's world persists between rebuilds. When the simulation version
changes, [`tools/e2e/compose.e2e.yml`](../../tools/e2e/compose.e2e.yml) carries the upgrade
flags that move the test world onto the new rules.

### Debugging against the stack

For live inspection, run the observer's dev server against the stack:

```bash
(cd packages/client && npx vite --config vite.e2e.config.ts)   # http://localhost:5299
```

It proxies `/api` and `/live` to the stack and exposes `window.__vana` (scene, camera, follow
controller, animal layer, store, live recordings and replay) for the browser console and for
scripts such as the video tools.

## Browser journeys

`tools/e2e/journeys.ts` drives the built site in real Chromium the way a visitor or the
operator would, and fails on any page error. Evidence (screenshots, logs) lands in
`.ci-artifacts/e2e/`.

```bash
npx tsx tools/e2e/journeys.ts                 # all journeys
npx tsx tools/e2e/journeys.ts observer follow # some of them
```

They cover, among others: the observer loading with its population, the phone layout, following
an animal and its passport, the event map and visiting an event, the village, a recorded hunt,
life replay and history, sharing, view options, the "Play as an AI agent" page and a live agent
taking over and moving an animal. Journeys use only test values on the local stack.

Rendering needs a real GPU: the tools launch Chromium with
`--use-angle=metal --enable-gpu --ignore-gpu-blocklist` on macOS; the software renderer is too
slow for the 3D scene.

## Performance and load

- `tools/e2e/perf.ts` measures frame time and load in the browser
  ([`docs/2026-10-05-browser-journeys-and-performance.md`](../2026-10-05-browser-journeys-and-performance.md)).
- `tools/ops/load.ts` drives the local stack with spectators and live agents and samples the
  server's metrics ([`docs/2026-10-05-load-test.md`](../2026-10-05-load-test.md)). Never point it
  at a public deployment.
