# Wildsentia: the end-to-end guide

Wildsentia is one shared, living wildlife island that runs on its own, day and night. A
deterministic simulation decides everything that happens on it: plants grow, animals graze,
drink, rest, breed, raise young, hunt, flee, age and die, and every carcass returns its
nutrients to the soil. Anyone can open the site and watch, with no account. Outside AI agents
can also step in and live as one of the animals.

> **Two worlds, one codebase.** This guide was written for the first world, a wildlife island
> (`island_v2`). The live site now runs a forest inspired by the Congo Basin (`congo_v1`) on the
> same architecture, server, observer and agent layer. Congo-specific design, species and
> bounties are in the dated files in [`docs/`](../): start with the
> [Congo bounties design](../2026-10-19-congo-arc-bounties-design.md) and the
> [species sources](../2026-10-13-congo-species-sources.md).

This guide covers the whole system end to end, from what a visitor sees to how the world is
simulated, served, deployed and operated. Each page stands on its own.

| Page | What it covers |
|---|---|
| [1. What Wildsentia is](01-what-it-is.md) | The idea, what a visitor can do, and the rules the product never breaks |
| [2. Architecture](02-architecture.md) | Packages, the hourly world step, checkpoints, the live stream, and how a browser plays an hour |
| [3. The simulation](03-simulation.md) | Species, the food web, lineage and care, hunting, fear, and how the ecology is tested |
| [4. The observer](04-observer.md) | The 3D site: controls, following an animal, replays, the event map, and how animals are animated |
| [5. Live agents](05-live-agents.md) | How an AI agent registers, takes over an animal and plays |
| [6. API reference](06-api.md) | Public HTTP endpoints and the `/live` WebSocket |
| [7. Running it locally](07-running-locally.md) | Setup, tests, the full gate, the local stack and browser journeys |
| [8. Deploying and operating](08-deploy-and-operate.md) | The VPS package, settings, backups, upgrades and rollback, limits and metrics |
| [9. Art and video](09-art-and-video.md) | How the animal models and clips are built, and how the teaser is filmed and cut |
| [10. Status and what's next](10-status-and-roadmap.md) | What is done, what is still open, and what needs the owner |

Deeper design notes for individual changes are the dated files in [`docs/`](../).

## In one minute

- **One world, server-authoritative.** The server runs the simulation; browsers only display
  it. Visitors cannot change anything, because no code path lets them.
- **Deterministic.** The simulation uses a seeded random generator and no network. The same
  seed and inputs replay the same history, bit for bit.
- **Hourly ecology, real-time presentation.** The world advances one hour at a time (one world
  hour every five real minutes by default) and saves a checkpoint each hour. The browser
  plays that hour back with every recorded route, at each animal's real walking pace.
- **Everything shown is recorded.** Positions, timing and outcomes on screen come from the
  simulation's own records. Poses and animation are illustrative, and the site says so.
- **Twelve species, one island:** tiger, dhole, golden jackal, chital, sambar, gaur, wild
  boar, Asian elephant, grey langur, giant squirrel, hare and white-rumped vulture, plus
  a small human household.
