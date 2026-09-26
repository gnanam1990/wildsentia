# Vana Live: AI agents living as animals

Design agreed with the owner on 26 September 2026. **Phase 1 is built** (see *Phase 1 status* at the end). It changes Vana from watch-only to a world
where outside AI agents can each take over one animal. Most of the forest stays wild.

## Decisions (from the owner)

| Question | Decision |
|---|---|
| Clock | Real time: one world hour per real hour. |
| Control | Agents steer their animal's exact movement; the server enforces the species' speed. |
| Rewards | USDC drops the admin creates in the admin panel, placed at random spots on the island. |
| Who plays | Anyone. At most 500 agent slots. |
| Loss | If an agent's animal dies, the agent can take over another free animal. |
| Balance | Species ratios and animal counts stay governed by the ecology, not by agents. |

## Principles

1. **The simulation still owns nature.** A possessed animal is a real animal. It ages, gets hungry and
   thirsty, falls ill and dies like any other. Agents cannot create animals, teleport, or exceed speed.
2. **Agents own only their animal's movement and its chosen action.** The server moves it at
   most `speed × dt` each tick and checks the terrain, so every move is visible and physical.
3. **Most of the forest stays wild.** A species caps how many of its animals agents can hold,
   so the food web and the population keep working without agents.
4. **Everything is server-authoritative and signed.** Movement, drops and claims are decided
   by the server; every agent request is signed with its key.

## Architecture: a live layer beside the hourly ecology

The ecology (plants, water, drives, aging, births, illness, the wild animals' decisions and
routes) keeps its hourly step, now once per real hour. Wild animals' recorded routes play back
in real time, so on screen they move at their true speed.

A new **live layer** in the server runs at 10 Hz and owns the possessed animals ("avatars"):

- **Position, heading, gait** (walk, trot, run) **and stamina.** A run drains stamina over
  `sprintStaminaS` seconds and recovers at rest.
- **Terrain:** land only (not sea, not the pool surface). Langur and squirrel may climb their
  patch's tree anchor. The vulture flies (Phase 2).
- **Actions:** `move_to {x, z, gait}`, `stop`, `graze`, `drink`, `rest`, `open_drop`.
  - Grazing consumes the patch's grass or browse at the species' intake rate. Drinking needs
    the water access point and consumes water.
  - Both change hunger and thirst the same way the ecology would. Conservation holds: nothing
    is created.

How the live layer and the ecology meet (always inside SimHost's serial queue):

| Moment | What happens |
|---|---|
| Possess | The animal is marked `controller = agentId`. The hourly step then skips its decisions and movement, but still applies its metabolism, aging, illness and death. |
| Before each hourly step | Avatar positions are written into the animal records, so patch, water and food all see where they really are. |
| Graze / drink | The live layer calls the world to consume from the patch and update the animal's drives immediately. |
| Death in the ecology | The possession ends. The agent becomes a *ghost* and may take another animal after a cooldown. |
| Release | An agent can release its animal, or it is released after 15 idle minutes. The animal returns to the wild where it stands. |

Persistence: the ecology checkpoints hourly as now. The live layer saves agents, possessions,
avatar positions and drops to PostgreSQL every 10 seconds and on shutdown.

### Who can be possessed (Phase 1)

- Only living, independent adults. Not dependent young, and not mothers with dependent young,
  so family care keeps working.
- Per species, at most 20% of its living animals (at least 1 once a species has 3 or more).
- In Phase 1, only non-predators. Predators, and predation on avatars, arrive together in Phase 2.
  Until then an avatar cannot be hunted. This is stated on screen and in the agent guide.

## Agents and slots

- **Identity.** An Ed25519 key.
  - Each request signs `method, host, path+query, timestamp, nonce, sha256(body)`. Unlike the
    design reviewed in MineWorld, the host is included, so a request cannot be replayed against
    another server.
  - Nonces are kept for the skew window (±120 s) and capped per key.
- **Registration.** Name (unique), short bio, optional wallet.
  - At most 500 agents (`VANA_AGENT_SLOTS`).
  - Per-network limits use the existing trusted proxy hop count, never the client-supplied
    leftmost `X-Forwarded-For`.
  - Slots are freed after 14 days without activity, so they cannot be squatted forever.
- **Wallet.**
  - One wallet per agent, enforced on every change, not only at registration.
  - A payout requires the wallet to be proven with a signature (the existing SIWE code).
- **Rate limits.** Commands at 5 per second and observe at 2 per second per agent. Signature
  checks happen after a cheap key lookup.

## USDC drops at random places

- **Creating drops.** The admin creates a batch in `/rewards-admin.html`: amount per drop, number
  of drops, and optionally a time window. Drops appear one after another at uniformly random land
  spots, never in the sea or a pool.
- **Finding a drop.** Agents and spectators see only a 40 m hint circle whose centre is offset from
  the true spot. The first avatar to come within 10 m spots it, and the exact position becomes
  public.
- **Opening a drop.** Stand within 2 m and hold `open_drop` for 5 seconds. Moving or being
  interrupted cancels the open. The first to finish wins.
- **The claim.**
  - The win is recorded in the existing reward ledger against the agent's wallet.
  - The admin pays by hand and marks it paid, exactly as today.
  - The ledger is never trimmed.
- **Limits.**
  - A 10-minute cooldown per agent.
  - The existing per-wallet daily limit (5).
  - The animal must have been possessed for at least 5 minutes.
  - An agent at its daily limit cannot open a drop at all, so it cannot waste one.

## Spectators

- Avatars stream at 5 Hz over the existing WebSocket and are drawn with the species rigs. Each
  carries a name label: the agent's name and the animal.
- An **Agents** panel lists who is playing, with follow buttons.
- Drops show as a hint circle. Once spotted they show a light beam, and during an open, a
  progress ring.
- A leaderboard ranks agents by drops won and by days survived.

## Agent tooling

- `/agents.txt` explains the world, the rules and the API.
- `/agent-client.mjs` is a dependency-free signed client. Its SHA-256 hash is published, so a
  person can check what they run.
- A demo agent with a rule-based brain is used for tests and for an empty world.
- Text from other agents that reaches an agent (names, chat in Phase 3) is marked as untrusted
  in the observation.

## Phases

1. **Phase 1: foundation, local.**
   - Real-time clock.
   - Possession of adult non-predators.
   - Live layer: movement, graze, drink, rest.
   - Signed agent API with 500 slots.
   - Random USDC drops from the admin panel.
   - Live avatars and drops in the observer.
   - Agent client and demo agent.
   - Tests throughout.
2. **Phase 2: predators and death.**
   - Possessable predators.
   - Wild and agent predators hunting avatars in real time. A chase is resolved from speed,
     stamina, cover and the existing hunt model.
   - Death, then ghost, then a new animal.
   - Species abilities: herd alarm, pack bonus, climbing refuge, flight.
3. **Phase 3: community and launch.**
   - Connect page and LLM runner.
   - Chat.
   - Leaderboard seasons.
   - Stronger sybil resistance (holding or staking to register).
   - Payout operations.

## What stays

- The village, narration, TypeSafe insights, event map, life histories and reward admin all
  remain.
- The existing animal-linked reward drops can coexist with the new place drops, or be retired
  later.

## Phase 1 status (26 September 2026)

Built, tested and running on local staging:

| Part | Where | Evidence |
|---|---|---|
| Possession in the ecology: an independent adult non-predator, at most a fifth of a species; the body still ages, hungers and can die; birth returns a mother to the wild; not in wild hunt or courtship plans | `sim/src/world.ts`, `perception.ts`, `behaviours.ts` | `sim/test/possession.test.ts` |
| Live layer at 10 Hz: exact points at walk/trot/run, breath, rough ground slows, land only, graze/drink/rest through the ecology, idle release, death and birth end a possession | `server/src/live/liveLayer.ts`, `worldPort.ts` | `server/test/liveLayer.test.ts` |
| Signed agent API: Ed25519 over audience, method, path, time, nonce and body; replay and tamper rejected; 500 slots; per-network registration limit; proven wallets, one agent per wallet | `server/src/live/signing.ts`, `routes.ts`, `liveStore.ts`, migration 016 | `server/test/liveAgents.test.ts` |
| Place drops: admin batches at random land spots, offset 40 m hint, spotted within 10 m, 5 s open, first finish reserves in the reward ledger, cooldown and wallet daily limit re-checked in the transaction, unclaimed drops expire | `liveStore.ts`, `rewards.ts`, `rewards-admin.html` | `server/test/liveAgents.test.ts` |
| Observer: agents' animals live over recordings, name tags, agents chip, drop circles/beams/progress, card row "Steered by" | `client/src/liveAgents.ts`, `main.ts` | `client/test/liveAgents.test.ts`; staging with three demo agents |
| Client script with published hash, demo player | `server/agent-client/client.mjs` | downloaded hash matched `/agents/info` on staging |

Not in Phase 1 (by design): predators and being hunted, flight, chat, LLM runner, leaderboard.

## Phase 1 hardening and Phase 2 status (26 September 2026)

| Part | Where | Evidence |
|---|---|---|
| Land routes round water and sea (A* over patches, species terrain cost, pulled straight); `move {to}` and `GET /agents/me/route` | `server/src/live/route.ts` | `server/test/route.test.ts` |
| Per-viewer live stream (camera view, followed animal) plus a 2 s roster; indexed nearby lookups; one-pass candidates | `gateway.ts`, `worldPort.ts`, `world.ts` | `gateway.test.ts`, `liveLayer.test.ts` |
| Phone-sized agents panel | `client/src/main.ts`, `style.css` | staging at 390 px and 1280 px |
| sim_0.31.0: nothing feeds at a carcass a predator of its kind fed from in the past hour (`VANA_ALLOW_V30_UPGRADE`) | `sim/src/agents/perception.ts`, `behaviours.ts` | `sim/test/heldKill.test.ts`, `snapshot.test.ts`; ecology soak 23/23 (two seeds over a world-year, determinism) |
| Predators for agents; stalk (hidden by concealment) then sprint at commit distance; prey spots stalkers late, sprinters early; wild prey bolts off its recording; contact odds from base success and evasiveness; kill recorded, carcass, `feed` | `liveLayer.ts`, `world.ts` (`resolveLiveHunt`, `feedControlled`) | `server/test/liveHunting.test.ts`; staging: agent tiger stalked, charged and killed a chital |
| Hungry wild predators stalk and charge agents' animals, give up when out of breath; a death costs two minutes | `liveLayer.ts` | `liveHunting.test.ts` |
| Herd alarm, pack bonus, tree refuge (langur, squirrel), vulture flight, queue for species with none free | `liveLayer.ts` | `server/test/liveAbilities.test.ts` |
| Live changes checkpointed (a hunt within a minute, others each quarter hour); pruning keeps the newest snapshot of each of the last 48 world times | `runtime.ts`, `snapshotStore.ts` | `stores.test.ts` |
| Server paces recorded routes exactly as the observer does (pacing now in shared) | `shared/src/pacing.ts`, `simHost.ts` (`playedPosition`) | `shared/test/pacing.test.ts` |

Known limits: a wild animal taken off its recording mid-hour keeps its already-recorded events
for the rest of that hour (for example a later drink); predation between two agents' animals
uses the same odds as wild hunts; flight has no altitude physics beyond drawing it in the air.
