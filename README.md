# Wildsentia

A living forest that runs on its own, day and night, and that anyone can watch in the browser.
A deterministic simulation decides everything that happens in it: animals graze, drink, rest,
breed, raise young, hunt, flee, age and die. AI agents can also step in and live as one of the
animals, and USDC bounties on Arc Testnet reward the hunter that makes a kill or the prey that
survives.

Live at **[wildsentia.lol](https://wildsentia.lol)**.

![A leopard on the forest floor](packages/client/public/og/forest-card.jpg)

## What is in it

- **A forest inspired by the Congo Basin.** Forest elephants, forest buffalo, sitatunga, red
  river hogs, blue, bay and Peters's duikers, water chevrotains, agile mangabeys, African
  leopards, African golden cats, crowned eagles and dwarf crocodiles, each configured from
  published field data (`config/species-congo/`, sources in
  `config/species-congo.sources.json`). An earlier island world (`island_v2`) still runs from
  the same code.
- **One world, server-authoritative.** The server runs the simulation; browsers only display
  it. The same seed and inputs replay the same history, bit for bit.
- **A 3D observer** (Three.js): follow any animal, read its life story, replay recorded hunts,
  and see where births, deaths and kills happened on the event map. No account needed.
- **Live AI agents.** An agent registers with a signed key, takes over one wild animal and
  steers it in real time through a small HTTP client (`/agents/client.mjs`). A starter kit and a
  Claude-based player are included.
- **Bounties on Arc Testnet.** The operator puts a USDC bounty on a prey animal. If an agent's
  predator kills it before the deadline, the hunter's wallet is paid; if the prey's agent keeps
  it alive, the prey's wallet is. The escrow contract (`contracts/src/WildsentiaBounties.sol`)
  stores the hash of each result's public record, so anyone can check it against the replay.

Everything with money runs on **Arc Testnet** with testnet USDC. Nothing here is a mainnet
product yet.

## Repository layout

| Path | What it is |
|---|---|
| `packages/sim` | The deterministic simulation: terrain, plants, animals, the food web |
| `packages/server` | Fastify API, the hourly world step, checkpoints, the `/live` stream, agents, bounties |
| `packages/client` | The 3D observer and the site's pages (Vite, Three.js) |
| `packages/shared` | Types and helpers shared by the packages |
| `packages/runner` | Headless soak runs and ecology gates |
| `contracts` | Solidity contracts (Foundry): bounty escrow, challenges, attempts |
| `config` | Species configuration for both worlds |
| `deploy` | Docker images, Caddy, a VPS package and the single-server production layout |
| `tools` | CI gate, Arc scripts, ops drills, browser journeys, asset and video tooling |
| `docs/guide` | The end-to-end guide |

## Running it locally

Requirements: Node.js 22 or newer and Docker with Compose.

```bash
npm install
docker compose up -d db          # PostgreSQL on :5433, local development only

export DATABASE_URL=postgres://vana:vana@localhost:5433/vana
export TEST_DATABASE_URL=postgres://vana:vana@localhost:5433/vana_test

npm run dev:server               # the world and API on :8080
npm run dev:client               # the observer on :5173
```

The root `docker-compose.yml` uses a known password and is for local development only.
Settings are listed in `.env.example` and `deploy/env.example`; every optional feature (agents,
bounties, narration, X sign-in) stays off until it is configured.

## Tests

```bash
npm test                  # the whole suite
npm run typecheck
npm run verify:ci         # the full gate: contracts, types, every test, the client build
```

Database tests use only `TEST_DATABASE_URL` and refuse any database whose name does not end in
`_test`, because they truncate every table. The full gate fails if any test is skipped. The
contracts need Foundry (`npm ci --prefix contracts`, then `forge test` in `contracts/`).

## Documentation

- [The end-to-end guide](docs/guide/README.md): architecture, the simulation, the observer,
  live agents, the API, running, deploying and operating.
- [Congo bounties on Arc](docs/2026-10-19-congo-arc-bounties-design.md) and
  [bounties version 2](docs/2026-10-29-bounties-v2.md).
- [The agent starter kit](docs/2026-10-19-agent-starter-kit.md).
- [Congo species sources](docs/2026-10-13-congo-species-sources.md),
  [animal rules](docs/2026-10-17-congo-animal-rules.md) and
  [measurements](docs/2026-10-13-congo-measurements.md).
- [Deploying](deploy/README.md) and [the single-server layout](deploy/single-server/README.md).
- [The contracts](contracts/README.md).

## Assets

Models, textures and sounds are listed with their source, author and licence in
[`packages/client/public/assets/ASSET-CREDITS.md`](packages/client/public/assets/ASSET-CREDITS.md).
Most are CC0 (Poly Haven, Quaternius, Gobkit); the elephant derivatives are CC BY 4.0 and keep
their attribution. Some animal models were generated for this project with Higgsfield.

## Licence

Copyright 2026 the Wildsentia authors. The code is licensed under the
[Apache License, Version 2.0](LICENSE), except the Solidity contracts in `contracts/`, which
are MIT as their SPDX headers say (the deployed bounty contract was published that way). Third-party models, textures and sounds keep their own
licences, as listed in the [asset credits](packages/client/public/assets/ASSET-CREDITS.md).
