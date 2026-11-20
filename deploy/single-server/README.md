# Wildsentia on one server

The production layout: one Linux host running Postgres, the server and Caddy with Docker Compose
(`deploy/single-server/compose.yml`). The server's settings live in private env files on the host,
not in this repository, because a production world carries the Congo profile, Arc bounties and the
Circle signer.

## The host

- Any recent Linux with Docker Engine and the Compose plugin. Production runs Ubuntu 24.04 LTS.
- SSH by key only, password login off.
- A firewall that allows 22, 80 and 443 (TCP) and 443 (UDP) only, and something like fail2ban on SSH.
- Size it from a measured run (deploy/README.md): Postgres WAL, daily dumps and headroom.

## Behind Cloudflare

When the domain's DNS is on Cloudflare with the records proxied:
- Put Cloudflare's address ranges (https://www.cloudflare.com/ips-v4 and /ips-v6, space-separated)
  in `/etc/wildsentia/db.env` as `VANA_TRUSTED_PROXIES`, and set `VANA_TRUSTED_PROXY_HOPS=2` in
  `/etc/wildsentia/server.env`. Caddy then keeps Cloudflare's X-Forwarded-For and the server's
  rate limits see each visitor, not the CDN. A request that reaches the server directly cannot
  forge its address: Caddy replaces an untrusted client's X-Forwarded-For with its own address.
- SSL/TLS mode **Full (strict)**: Caddy keeps its own Let's Encrypt certificate and renews it over
  HTTP-01, so leave Cloudflare's "Always Use HTTPS" off (Caddy already redirects to HTTPS).
- WebSockets on (the default): the live forest is served at `/live`.
- Keep the host's own address private: anyone who has it can reach the server around the CDN.

## What runs

`deploy/single-server/compose.yml`, from `/opt/wildsentia` (a `git archive` of the deployed commit):

| Service | Image | Notes |
|---|---|---|
| `db` | `postgres:18-alpine` | Owner `vana`. Never published. Data in the `wildsentia_db_data` volume. |
| `server` | `deploy/Dockerfile.server` | Every setting from `/etc/wildsentia/server.env`. |
| `web` | `deploy/Dockerfile.web` | Caddy with the built observer. Publishes 80 and 443 and gets its own TLS certificates. |

The private files, mode 600 and never in git:
- **`/etc/wildsentia/db.env`:** `POSTGRES_PASSWORD`, and `VANA_DOMAIN` (for example
  `forest.example.com, www.forest.example.com`).
- **`/etc/wildsentia/server.env`:** every server variable (`deploy/env.example`), with
  `DATABASE_URL` pointing at `db:5432/<database>` and `VANA_TRUSTED_PROXY_HOPS=1` when Caddy is
  the only proxy.

Keep a copy of both files off the host.

```bash
cd /opt/wildsentia
C="docker compose -f deploy/single-server/compose.yml --env-file /etc/wildsentia/db.env"
$C ps
$C logs --tail 100 server
$C up -d --build          # after replacing /opt/wildsentia with a newer archive
```

## Deploying a new commit

```bash
git archive --format=tar.gz -o wildsentia-src.tgz origin/main
scp -i ~/.ssh/<your-key> wildsentia-src.tgz <user>@<host>:/root/
ssh -i ~/.ssh/<your-key> <user>@<host> \
  'tar -xzf /root/wildsentia-src.tgz -C /opt/wildsentia && cd /opt/wildsentia && \
   docker compose -f deploy/single-server/compose.yml --env-file /etc/wildsentia/db.env up -d --build'
```

The server restores its last checkpoint on restart. Run only one server per world: two would run
two bounty engines with the same evaluator.

## Backups

- **Daily dump:** a cron job that writes a custom-format dump (`pg_dump -Fc`) from the `db`
  container to `/var/backups/wildsentia/`, checks that it lists (`pg_restore -l`), and keeps the
  last seven.
- **Off the server:** copy a dump off the host now and then.

## Moving a world between hosts

1. **Copy over.** Pull the database with `pg_dump -Fd -j 4` and load it with `pg_restore -j 4`.
   Treat the first copy as a rehearsal: boot the new host on it with Arc bounties off and check it
   reaches the dump's world time.
2. **Cut over.**
   - Stop the old server, so the world and the bounty engine run in one place only.
   - Copy again, then start the new stack with the production settings.
   - Point the domain's `A` records at the new host (a short TTL helps); Caddy obtains the
     certificates once the names resolve to it.
3. **Keep the old host stopped**, not running, until you no longer need it for a rollback.
