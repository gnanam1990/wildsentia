# Wildsentia: 30-real-day VPS handoff

This package runs **one persistent island world** with the household, the built observer,
PostgreSQL, and HTTPS. At 12 world-hours per real hour, an uninterrupted 30-day run advances
360 simulated days. The user supplies and operates the VPS, DNS/domain, firewall, backups and
external monitoring. A successful local soak is not proof of 30 days of wall-clock uptime.
The current `sim_0.30.0` tree is a **release candidate, not a completed 30-day deployment**.
The flowering guild's first seed recruitment is eligible only in the next simulated year
(around simulated day 370), so a fresh exactly-30-real-day run at 12× reaches blooms
and seed maturation, but not that first recruitment window.

## Before first boot

- Install Docker Engine and Docker Compose on a Linux VPS; ensure Docker starts after reboot.
- Point an A/AAAA record for your domain at this VPS. Allow inbound TCP 80 and 443 and, if
  desired, UDP 443. Caddy obtains and renews TLS automatically when DNS/reachability work.
- Keep the database private. `compose.yml` publishes only the web proxy; it never publishes
  PostgreSQL or the Node server. Do not expose the old root `docker-compose.yml` publicly:
  that file is a local development setup with a known password.
- Plan storage from a measured 24- to 48-hour run, including Postgres WAL, daily dumps and
  headroom. The simulation can write roughly millions of routine events per real day;
  housekeeping prunes old routine rows but does not remove every life event.
- Use a **fresh** database volume for the current world. Do not point this package at a
  differently versioned world or change the island/household profile on an existing save.
- Leave `VANA_SOCIAL_*` and model/API keys unset. This run package does not
  send USDC, publish to X or require paid services.
- Rewards stay off until you set `VANA_REWARD_NETWORK`, `VANA_REWARD_POLICY` and
  `VANA_REWARD_ADMIN_TOKEN` (see `env.example`). With them set, visitors can claim drops you
  allocate in `/rewards-admin.html`; you send each USDC payment yourself and then mark it paid
  there. Defaults: 60 s of watching before a claim, 5 wins per wallet per day, no per-network
  limit. `VANA_TRUSTED_PROXY_HOPS` is already `1` for Caddy; do not raise it unless another
  proxy sits in front.

From the repository root on the VPS:

```bash
cp deploy/env.example deploy/.env
openssl rand -hex 32          # paste the result as VANA_DB_PASSWORD in deploy/.env
chmod 600 deploy/.env
# Edit VANA_DOMAIN to the real domain before proceeding.
docker compose --env-file deploy/.env -f deploy/compose.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yml build
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
docker compose --env-file deploy/.env -f deploy/compose.yml ps
curl -fsS https://YOUR_DOMAIN/api/health
```

`/api/health` must return `ok:true`. Visit `https://YOUR_DOMAIN/` and verify the 3D world
loads, then call health again after 6–10 minutes: `worldTime` must advance by 3600 seconds.
Large WebSocket scenes are sent on checkpoint/recording changes, not every second; small
keepalives maintain quiet connections, and large messages negotiate compression.
Public `/live` is the observer WebSocket. The server records a durable checkpoint every world
hour (nominally every 5 real minutes); it restores that checkpoint after restart. A hard crash
can lose work since the last checkpoint, not the entire world.

## Daily operations

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml ps
docker compose --env-file deploy/.env -f deploy/compose.yml logs --tail=100 server
curl -fsS https://YOUR_DOMAIN/api/health
./deploy/backup.sh /ABSOLUTE/PRIVATE/BACKUP/DIRECTORY
docker compose --env-file deploy/.env -f deploy/compose.yml exec -T db \
  psql -U vana -d vana -Atc "select pg_size_pretty(pg_database_size('vana'))"
df -h
```

Schedule `backup.sh` once per day with your VPS scheduler and copy verified dumps **off the
VPS**. The script uses a private file, checks that the custom archive can be listed, and never
deletes old backups; configure retention only after proving an offsite copy and restore.
Monitor HTTPS health and `worldTime` progress externally at least every 10 minutes. Alert on
HTTP failure, unchanged `worldTime` for 15 minutes, a missing container, low free disk, or a
missed backup. Docker restarts exited services, but merely marking one unhealthy does not
restart it. The server therefore exits after writer loss, three consecutive failed scheduled
ticks, or a stale checkpoint; Compose restarts it from the last durable save.

For an append-only **sampled 30-real-day acceptance journal**, run the included monitor on a
separate machine if possible, under an operator-managed supervisor that restarts it after
machine reboot. Its private journal survives monitor restarts; a sampling gap over 15 minutes
is recorded as a failure, not silently ignored:

```bash
mkdir -m 700 /ABSOLUTE/PRIVATE/MONITOR/DIRECTORY
node tools/ops/monitor-30d.mjs \
  --url https://YOUR_DOMAIN/api/health \
  --journal /ABSOLUTE/PRIVATE/MONITOR/DIRECTORY/vana-30d.jsonl
```

Keep that process and journal outside disposable containers. It samples every 10 minutes,
records failed HTTPS checks, a non-advancing or rolled-back world clock, and observer gaps;
it also rejects a world that falls more than one saved hour behind the configured 12× rate.
After 30 actual days it reports `accepted:true` only with zero recorded incidents. A sampled
journal cannot prove every second between checks, and it does not replace disk, backup, TLS,
container, host-reboot or browser monitoring. Do not start the 30-day clock from a simulated
soak or a local smoke test.

For a restore rehearsal, create a **separate** database and restore a dump there; never run
the following against `vana`:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml exec -T db \
  createdb -U vana vana_restore_test
docker compose --env-file deploy/.env -f deploy/compose.yml exec -T db \
  pg_restore -U vana -d vana_restore_test < /ABSOLUTE/PRIVATE/BACKUP/DIRECTORY/FILE.dump
docker compose --env-file deploy/.env -f deploy/compose.yml exec -T db \
  psql -U vana -d vana_restore_test -Atc 'select count(*) from snapshots'
```

Stop/start with `docker compose ... stop` and `docker compose ... start`. Never use
`docker compose down -v`: that deletes the persistent world and TLS volumes. Before a code
upgrade, take and verify a backup; preserve the old image and database until the new build
passes restart and health checks. Do not enable version-upgrade flags without a separate
checkpoint migration review. To move a saved `sim_0.34.0` world to this code after a
verified backup, add `VANA_ALLOW_V34_UPGRADE: "1"` to the server's environment in a compose
override for one start, confirm `/api/health`, then remove it. (Each flag names the saved
world's version and moves it straight to this runtime: a `sim_0.33.0` world uses
`VANA_ALLOW_V33_UPGRADE`, a `sim_0.32.0` world `VANA_ALLOW_V32_UPGRADE`.) An upgraded island
keeps the animals it was founded with; only new worlds get the calibrated predator cohort.

## Upgrade and rollback

Rehearsed end to end by `tools/ops/rollback-drill.sh` on a copy of a world; the evidence and
what it shows are in `docs/2026-10-05-rollback-drill.md`. In short: a rollback returns the
world, the reward ledger and live possessions to the moment of the backup, never to a new
world, and anything after the backup is lost. So back up **immediately** before upgrading.

```bash
C="docker compose --env-file deploy/.env -f deploy/compose.yml"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
# 1. Keep the running images under a name a rebuild cannot overwrite.
docker tag vana-30day-server:latest vana-30day-server:rollback-$stamp
docker tag vana-30day-web:latest vana-30day-web:rollback-$stamp
# 2. Back up, and keep the path it prints.
./deploy/backup.sh /ABSOLUTE/PRIVATE/BACKUP/DIRECTORY
# 3. Build and start the new code on the same database.
git pull --ff-only   # or check out the release you are moving to
$C build && $C up -d --wait
$C logs --tail=50 server | grep -E 'restored world at|booted a fresh world'
curl -fsS https://YOUR_DOMAIN/api/health   # again 6-10 minutes later: worldTime must have moved on
```

The log must say `restored world at …`. **`booted a fresh world` on an existing install means
the server did not find the saved world: stop it at once and roll back.** Health must be
`ok:true`, and `worldTime` must advance. The metrics below should show
`vana_world_tick_failures_total` flat and `vana_checkpoint_age_seconds` under the world-hour
interval.

To roll back (previous images plus the backup from step 2):

```bash
$C stop server web
$C exec -T db dropdb -U vana vana
$C exec -T db createdb -U vana vana
$C exec -T db pg_restore -U vana -d vana --no-owner --no-acl < /ABSOLUTE/PRIVATE/BACKUP/DIRECTORY/FILE.dump
docker tag vana-30day-server:rollback-$stamp vana-30day-server:latest
docker tag vana-30day-web:rollback-$stamp vana-30day-web:latest
$C up -d --no-build --wait
$C logs --tail=50 server | grep -E 'restored world at|booted a fresh world'
curl -fsS https://YOUR_DOMAIN/api/health
```

Always restore the backup on rollback, even when only the image changed. When the new code
changed the snapshot version, the previous image cannot boot on what it saved. Possessions
come back with their saved idle clock, so animals idle for 15 minutes or more go back to the
wild straight away. Rewards allocated, claimed or marked paid after the backup are not in the
restored ledger; record any USDC sent in that window again by hand. Keep the `rollback-*`
images and the backup until the new version has run cleanly for a day.

## Limits

These per-visitor limits hold everywhere. A visitor network is one IPv4 address or one IPv6
/64, as Caddy reports it (`VANA_TRUSTED_PROXY_HOPS`). Their defaults are in
`deploy/env.example`, and each can be set in `deploy/.env` (0 turns one off).

- **Public reads** (`VANA_PUBLIC_READS_PER_MINUTE`, default 1200 per network per minute, with
  bursts of 300). This covers the world, animals, history, event map, agents list and so on.
  Past it the server answers `429` with `Retry-After`. `/health`, rewards, admin, holder and
  signed agent calls have their own limits and are not counted.
- **`/live` connections** (`VANA_LIVE_MAX_CONNECTIONS`, default 1000 in total;
  `VANA_LIVE_MAX_CONNECTIONS_PER_NETWORK`, default 100). Past either cap, a new connection is
  closed with code 1013 ("try again later"), reason `busy` or `busy_network`. The observer
  then says the forest is at its viewer limit and retries after 8–120 s with jitter. Its
  ordinary reconnect also backs off, from 1–2 s up to a minute. The default total is the
  highest load tested on the reference machine (1000 viewers plus 500 agents held, with the
  main thread near one full core; `docs/2026-10-05-load-test.md`). Raise it only after running
  `tools/ops/load.ts` on the real host.

Watch `vana_http_rate_limited_total` and `vana_ws_connections_refused_total`. Refusals that
grow while the number of visitors is normal mean a limit is too low, often a large NAT.

## Metrics

The server serves Prometheus text on its own internal port, `VANA_METRICS_PORT` (default
9464), at `/metrics`. By default it binds to `127.0.0.1` inside the server container. That
port is never published, and nothing in Caddy proxies to it. Caddy also answers
`/api/metrics` itself with 404, under any spelling (`/api/%6detrics`, `/api/METRICS`,
`/api//metrics` and so on were probed against Caddy 2.11), and the public API has no such
route. To read the metrics:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml exec -T server wget -qO- http://127.0.0.1:9464/metrics
```

For a Prometheus server, run it as another service on the compose network, through a
private override, and set `VANA_METRICS_HOST=0.0.0.0` in `deploy/.env` so `server:9464` is
reachable from that network (still not from outside). Scrape every 15–30 s. Do not publish
9464 on a public interface. To scrape from elsewhere, use an SSH tunnel to a loopback-only
port mapping (`127.0.0.1:9464:9464` in an override).

| Metric | Meaning | Alert when |
|---|---|---|
| `vana_world_time_seconds`, `vana_checkpoint_age_seconds` | Saved world time; wall time since the last durable checkpoint | Age above 15 min (the watchdog restarts the server at the same point) |
| `vana_world_clock_lag_seconds` | World seconds behind the hours due since this process started; an hour while one is running | Above 3600 for more than one world hour |
| `vana_world_tick_failures_total`, `vana_world_consecutive_tick_failures`, `vana_world_ticks_skipped_total`, `vana_world_tick_duration_seconds` | Hourly step health and cost | Any failure; skipped ticks |
| `vana_event_loop_delay_seconds{quantile}`, `vana_live_tick_lag_seconds_max` | How long timers and requests wait, over 10 s windows; the 10 Hz agent tick's lateness | p99 above 0.1 s, or live tick lag above 0.25 s, for minutes |
| `vana_ws_connections`, `vana_ws_connections_accepted_total`, `vana_ws_connections_refused_total{reason}` | Open `/live` viewers and refusals by cap | Connections near `VANA_LIVE_MAX_CONNECTIONS` |
| `vana_ws_messages_sent_total`, `vana_ws_sent_bytes_total`, `vana_ws_broadcast_seconds_max{kind}` | Fan-out volume (bytes before compression), and the longest single broadcast loop | Scene broadcast above 0.5 s |
| `vana_ws_slow_consumer_terminations_total` | Viewers cut off for falling 16 MB behind | A steady rise |
| `vana_live_avatars`, `vana_live_agents_registered` | Animals steered by agents; slots taken | Registered near `VANA_AGENT_SLOTS` |
| `vana_http_responses_total{class}`, `vana_http_rate_limited_total` | API responses by status class; 429s | Any 5xx rate |
| `vana_db_pool_connections{state}`, `vana_db_pool_waiting_requests`, `vana_db_pool_max_connections` | API database pool | Waiting above 0 for minutes |
| `vana_world_info{world_id,sim_version}`, `process_*` | Running world and version; RSS, heap, CPU | RSS growing without bound |

## Load test

`tools/ops/load.ts` drives a stack started with `tools/e2e/stack.sh`. Spectators open `/live`
and move their camera every second. Live agents use the published `client.mjs` to register,
possess and move. During each step the tool samples `docker stats` and the metrics above.
Never point it at the public deployment. Results for the reference machine, and the
procedure, are in `docs/2026-10-05-load-test.md`.

## Verification boundary

The `sim_0.29.0` candidate completed three independent **730-simulated-day** island +
household samples with zero reported hard failures; all three ended with six living people
and all 12 listed animal species, but low predator counts and animal-care warnings remain.
These are ecology samples, **not** 30 real days or visual-quality acceptance. The last full
isolated PostgreSQL/typecheck/client-build gate before the village fuel-loop fix passed 1,233
tests; the post-fix full gate must also pass before packaging this candidate. The disposable
database restore rehearsal is in `docs/2026-09-25-staging-backup-restore-drill.md`, and the
local Docker packaging smoke is in `docs/2026-09-25-30day-docker-smoke-evidence.md`. These prove
specific code paths, **not** 30-day VPS uptime, internet reachability, TLS issuance, arbitrary
VPS capacity, production-grade art, or a real-USDC payout. The first live 24–48 hours are the
storage/performance and restart acceptance gate; keep monitoring throughout the 30 days.
