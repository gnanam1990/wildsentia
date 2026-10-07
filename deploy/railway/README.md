# Wildsentia on Railway

The same three parts as the VPS package (`deploy/compose.yml`), as Railway services in one
project. Railway's edge provides HTTPS for the custom domain, so Caddy here listens on plain
`$PORT` and only serves the observer and proxies the API.

| Service | Source | Notes |
|---|---|---|
| `Postgres` | Railway's PostgreSQL | Its volume holds the world. |
| `server` | `deploy/Dockerfile.server` | The simulation, API and `/live`. Private only; health check `/health`. |
| `web` | `deploy/railway/Dockerfile.web` | Caddy with the built observer; the only public service and the one the domain points at. |

## Variables

`server`:

| Variable | Value |
|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `deploy/Dockerfile.server` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `PORT` | `8080` |
| `WORLD_SEED` | `1` |
| `WORLD_HOURS_PER_REAL_HOUR` | `12` |
| `VANA_TERRAIN_PROFILE` | `island_v2` (a new world; an existing `island_v1` world must keep `island_v1`) |
| `VANA_TRUSTED_PROXY_HOPS` | `2` (Railway's edge, then Caddy) |
| `VANA_LIVE_AGENTS` | `1` |
| `VANA_LIVE_SECRET` | a random 64-character hex value |

Leave the reward, holder, social and model-key settings unset.

`web`:

| Variable | Value |
|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `deploy/railway/Dockerfile.web` |
| `SERVER_ADDR` | `server.railway.internal:8080` |

## Deploying

From the repository root with the Railway CLI logged in and linked to the project:

```bash
railway up --service server --detach
railway up --service web --detach
```

`railway up` uploads the working tree (honouring `.gitignore`) and builds the service's Dockerfile.

## Domain

Add `wildsentia.lol` (and `www.wildsentia.lol`) as custom domains on `web`, then create the DNS
records Railway shows (a CNAME, plus a TXT record to verify ownership) at the domain's DNS
provider. Railway issues the certificate once DNS resolves.

## Operations

- Health: `https://wildsentia.lol/api/health`; `worldTime` must advance by 3600 every world hour.
- Logs: `railway logs --service server`.
- Back up the `Postgres` service (Railway backups, or `pg_dump` with the service's public URL)
  before every upgrade. The upgrade flags and rollback steps in `deploy/README.md` apply as on a VPS.
