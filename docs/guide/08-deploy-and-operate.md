# 8. Deploying and operating

The server package in [`deploy/`](../../deploy) runs one persistent world on a Linux VPS:
PostgreSQL, the Node server, and Caddy serving the built site over HTTPS. Only Caddy is
published; the database and the Node server stay private.

## Before first boot

- Install Docker Engine and Docker Compose, and make sure Docker starts after a reboot.
- Point an A/AAAA record for your domain at the VPS. Open TCP 80 and 443 (and UDP 443 if you
  like). Caddy obtains and renews the TLS certificate itself once DNS reaches the machine.
- Plan disk from a measured 24–48-hour run, including PostgreSQL's WAL, daily dumps and
  headroom. The world writes millions of routine events per real day; housekeeping prunes old
  routine rows but keeps life events.
- Use a fresh database volume for a new world. Never point the package at a world saved by a
  different simulation version without the upgrade procedure below.

## Settings

Copy `deploy/env.example` to `deploy/.env` (never commit it) and set:

| Setting | Required | Meaning |
|---|---|---|
| `VANA_DOMAIN` | yes | The site's domain |
| `VANA_DB_PASSWORD` | yes | A random password (`openssl rand -hex 32`) |
| `VANA_WORLD_SEED` | | The new world's seed (default 1). Changing it later does not reseed an existing world. |
| `WORLD_HOURS_PER_REAL_HOUR` | | World speed (default 12; 1 for real time with live agents) |
| `VANA_LIVE_AGENTS`, `VANA_AGENT_SLOTS`, `VANA_AGENT_REGISTRATIONS_PER_NETWORK`, `VANA_LIVE_SECRET` | | Live agents (see [5. Live agents](05-live-agents.md)) |
| `TYPESAFE_AI_API_KEY`, `TYPESAFE_DAILY_CALLS`, `TYPESAFE_MODEL` | | Optional observer insights (estimates only; off without a key) |
| `VANA_PUBLIC_READS_PER_MINUTE`, `VANA_LIVE_MAX_CONNECTIONS`, `VANA_LIVE_MAX_CONNECTIONS_PER_NETWORK` | | Per-visitor limits (see [Limits](#limits)) |
| `VANA_METRICS_PORT`, `VANA_METRICS_HOST` | | The internal metrics port (see [Metrics](#metrics)) |

## First boot

From the repository root on the VPS:

```bash
cp deploy/env.example deploy/.env
openssl rand -hex 32          # paste as VANA_DB_PASSWORD
chmod 600 deploy/.env
# set VANA_DOMAIN in deploy/.env
C="docker compose --env-file deploy/.env -f deploy/compose.yml"
$C config --quiet
$C build
$C up -d
$C ps
curl -fsS https://YOUR_DOMAIN/api/health
```

`/api/health` must return `"ok":true`. Open the site and check the island loads. Call health
again 6–10 minutes later: `worldTime` must have advanced by 3600 (one world hour). The server
saves a checkpoint every world hour and restores it after any restart.

## Daily operations

```bash
$C ps
$C logs --tail=100 server
curl -fsS https://YOUR_DOMAIN/api/health
./deploy/backup.sh /ABSOLUTE/PRIVATE/BACKUP/DIRECTORY
$C exec -T db psql -U vana -d vana -Atc "select pg_size_pretty(pg_database_size('vana'))"
df -h
```

- **Back up daily** with `deploy/backup.sh` from the VPS scheduler, and copy the verified
  dumps off the machine. The script writes a private file, checks the archive can be read, and
  never deletes old backups.
- **Monitor externally** at least every 10 minutes. Alert on HTTPS failure, `worldTime` not
  advancing for 15 minutes, a missing container, low disk, or a missed backup.
- The server exits on purpose after losing its database lock, after three failed hourly steps
  in a row, or when its checkpoint goes stale; Compose then restarts it from the last save.
- `tools/ops/monitor-30d.mjs` keeps an append-only journal of health samples for a 30-day
  acceptance run. Run it on another machine:
  `node tools/ops/monitor-30d.mjs --url https://YOUR_DOMAIN/api/health --journal /PRIVATE/DIR/30d.jsonl`.
- **Never run `docker compose down -v`.** It deletes the world and the TLS certificates. Use
  `$C stop` and `$C start`.

### Restore rehearsal

Restore into a separate database, never into `vana`:

```bash
$C exec -T db createdb -U vana vana_restore_test
$C exec -T db pg_restore -U vana -d vana_restore_test < /PRIVATE/BACKUP/FILE.dump
$C exec -T db psql -U vana -d vana_restore_test -Atc 'select count(*) from snapshots'
```

## Upgrade and rollback

Back up immediately before upgrading: a rollback returns the world to the moment of the backup,
and anything after it is lost. The procedure is rehearsed by `tools/ops/rollback-drill.sh`
([`docs/2026-10-05-rollback-drill.md`](../2026-10-05-rollback-drill.md)).

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker tag vana-30day-server:latest vana-30day-server:rollback-$stamp
docker tag vana-30day-web:latest vana-30day-web:rollback-$stamp
./deploy/backup.sh /ABSOLUTE/PRIVATE/BACKUP/DIRECTORY        # keep the path it prints
git pull --ff-only                                          # or check out the release
$C build && $C up -d --wait
$C logs --tail=50 server | grep -E 'restored world at|booted a fresh world'
curl -fsS https://YOUR_DOMAIN/api/health                    # again 6–10 min later
```

The log must say `restored world at …`. **`booted a fresh world` on an existing install means
the server did not find the saved world: stop at once and roll back.**

**When the simulation version changed**, the server refuses the saved world until you allow
the move once: add `VANA_ALLOW_V34_UPGRADE: "1"` (named for the saved world's version, here
`sim_0.34.0`) to the server's environment in a compose override, start, confirm health, then
remove the flag. An upgraded world keeps its animals and history.

To roll back:

```bash
$C stop server web
$C exec -T db dropdb -U vana vana
$C exec -T db createdb -U vana vana
$C exec -T db pg_restore -U vana -d vana --no-owner --no-acl < /PRIVATE/BACKUP/FILE.dump
docker tag vana-30day-server:rollback-$stamp vana-30day-server:latest
docker tag vana-30day-web:rollback-$stamp vana-30day-web:latest
$C up -d --no-build --wait
```

Always restore the backup on rollback, even if only the image changed: an older image cannot
read what newer code saved. Agents' animals come back with their saved idle clock. Keep the
rollback images and the backup until the new version has run cleanly for a day.

## Limits

A visitor network is one IPv4 address or one IPv6 /64, as Caddy reports it. Set any limit to 0
to turn it off.

- **Public reads:** `VANA_PUBLIC_READS_PER_MINUTE` (default 1200 per network per minute,
  bursts of 300). Past it: `429` with `Retry-After`.
- **`/live` connections:** `VANA_LIVE_MAX_CONNECTIONS` (default 1000 in total) and
  `VANA_LIVE_MAX_CONNECTIONS_PER_NETWORK` (default 100). Past either, a new connection is closed
  with code 1013; the observer says the forest is at its viewer limit and retries after 8–120 s.
  The default total is the highest load tested on the reference machine. Raise it only after
  running the load test on the real host.

## Metrics

The server serves Prometheus text on an internal port (`VANA_METRICS_PORT`, default 9464),
bound to `127.0.0.1` inside its container and never proxied by Caddy:

```bash
$C exec -T server wget -qO- http://127.0.0.1:9464/metrics
```

| Metric | Alert when |
|---|---|
| `vana_checkpoint_age_seconds` | Above 15 minutes |
| `vana_world_clock_lag_seconds` | Above 3600 for more than a world hour |
| `vana_world_tick_failures_total`, `vana_world_ticks_skipped_total` | Any increase |
| `vana_event_loop_delay_seconds{quantile="0.99"}` | Above 0.1 s for minutes |
| `vana_live_tick_lag_seconds_max` | Above 0.25 s for minutes (live agents) |
| `vana_ws_connections` | Near the connection cap |
| `vana_ws_connections_refused_total`, `vana_http_rate_limited_total` | Growing while visitors are normal (a limit is too low) |
| `vana_ws_slow_consumer_terminations_total` | A steady rise |
| `vana_http_responses_total{class="5xx"}` | Any |
| `vana_db_pool_waiting_requests` | Above 0 for minutes |
| `process_resident_memory_bytes` | Growing without bound |

More detail and every metric: [`deploy/README.md`](../../deploy/README.md#metrics).

## Load test

`tools/ops/load.ts` drives a local stack (never the public site) with spectators that move
their cameras and live agents that register, take animals and move, while sampling container
stats and metrics. On the reference machine the server held 1000 viewers plus 500 agents
([`docs/2026-10-05-load-test.md`](../2026-10-05-load-test.md)). Repeat it on the real host
before raising the limits.
