# VANA: 30-real-day VPS handoff

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
checkpoint migration review. To move a saved `sim_0.29.0` world to this code after a
verified backup, add `VANA_ALLOW_V29_UPGRADE: "1"` to the server's environment in a compose
override for one start, confirm `/api/health`, then remove it.

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
