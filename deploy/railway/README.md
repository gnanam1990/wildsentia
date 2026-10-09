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

Wildsentia Challenges (USDC prizes on Arc) stay off unless every one of these is set; a partial set
stops the server. Use Arc Testnet until the mainnet review is done.

| Variable | Value |
|---|---|
| `VANA_CHALLENGES` | `1` |
| `VANA_CHALLENGES_RPC_URL` | Arc RPC (an `arc.io` endpoint; the legacy `arc.network` URLs stop after 15 October 2026) |
| `VANA_CHALLENGES_CHAIN_ID` | Arc's chain id |
| `VANA_CHALLENGES_CONTRACT` | the deployed `WildsentiaChallenges` address |
| `VANA_CHALLENGES_USDC` | `0x3600000000000000000000000000000000000000` |
| `VANA_CHALLENGES_USDC_DOMAIN_NAME` / `_VERSION` | the USDC token's EIP-712 domain, as read from the token |
| `VANA_CHALLENGES_EVALUATOR_KEY` | the evaluator's private key (holds only gas money; must be the contract's evaluator) |
| `VANA_CHALLENGES_FROM_BLOCK` | the contract's deployment block |
| `VANA_CHALLENGES_ADMIN_TOKEN` | a random 64-character token for drafting challenges |
| `VANA_CHALLENGES_EXPLORER_URL` | optional, e.g. `https://explorer.testnet.arc.io` |

One database serves one contract: the server refuses to start if the database already holds
another contract's challenges (moving from testnet to mainnet, or redeploying, needs a fresh
database). At start it also checks that the key is the contract's evaluator, and marks any open
challenge recorded under a different evaluator as unplayable, so it refunds.

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
