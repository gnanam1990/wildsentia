# Congo bounties paid on Arc: design (19 October 2026)

Status: being built on `feat/congo-arc-bounties`, Arc Testnet only. Mainnet waits for the owner's go-ahead after the testnet demo.

## What the owner asked for

- AI agents each steer one animal in the Congo forest, a hunter or a prey.
- A bounty in USDC is put on a prey animal that the operator picks **at random**.
- **The hunter wins:** if an agent's predator kills that animal before the deadline, the bounty
  goes to that agent's wallet.
- **The prey wins:** if the prey's agent keeps it alive until the deadline, the bounty goes to
  the prey agent's wallet.
- Everything is recorded on Arc.
- **Playing is free:** no token holding and no stake.
- **Funding:** the treasury funds the pool in USDC.

## What already exists (main, 19 October)

- **Congo 1D bounties** (`packages/server/src/bounties/`):
  - drafts, validation, publication and adjudication;
  - hidden targets, discovered by perception and clues;
  - an outage hold, and exactly-once settlement.
  - The money is simulated, and the payee is the animal's owner.
- **Live agents** (`packages/server/src/live/`) steer animals. On the Congo they may steer only
  owned animals (1C).
- **The island's Arc escrow** (`contracts/src/WildsentiaChallenges.sol`): a "first to finish"
  escrow, with a viem chain client and a transaction queue (`packages/server/src/challenges/`).
  It was never deployed.

The challenge escrow does not fit bounties:
- its 12-hour minimum window is longer than a 3-world-day bounty (6 real hours);
- it cannot return a voided bounty before its deadline;
- it pays one kind of winner.

So bounties get their own small contract.

## The contract: `WildsentiaBounties`

A pool-funded escrow. Amounts are in USDC's 6-decimal ERC-20 units.

| Function | Who | What |
|---|---|---|
| `fund(amount)` | anyone (the treasury) | Moves approved USDC into the pool |
| `publish(id, amount, expiresAt, rulesHash, targetCommit)` | evaluator | Reserves `amount` from the pool for bounty `id`. `targetCommit = keccak256(targetId, salt)` keeps the target secret. |
| `settle(id, outcome, payee, recordHash, targetId, salt)` | that bounty's evaluator, before `expiresAt` | Pays the hunter's or the prey's agent wallet. The revealed target must match the commit. The hash of the public record is stored. |
| `voidBounty(id, recordHash, targetId, salt)` | that bounty's evaluator | Returns the reservation to the pool (the target died another way, no agent steers it, ...) |
| `expire(id)` | anyone, after `expiresAt` | Returns an unsettled reservation to the pool. Never paused. |
| `withdraw(amount, to)` | owner | Takes unreserved pool money only; a reserved bounty can only be paid or returned |
| `setEvaluator`, `setSettlePaused`, `setAmountLimits` | owner | As in the challenge escrow |

The evaluator key pays gas and decides. It can never take money for itself: a payee cannot be the
evaluator, the owner, the contract or the zero address. Each bounty keeps the evaluator it was
published under. `expiresAt` is wall-clock time: the server sets it to the world-time deadline's
due time plus a margin, so an outage cannot strand the money.

## The server

**Agent mode** (`VANA_BOUNTY_PAYEE=agent`), with free play on the Congo (`VANA_CONGO_OPEN_PLAY=1`):
- agents may steer wild Congo animals, as on the island;
- the payee is the **proven wallet of the agent steering the animal**, not an owner.

**Random target** (`POST /congo/admin/bounties/random`, preset):
- The server picks one at random among living prey animals of non-protected species.
- Each candidate is steered by an agent with a proven wallet.
- An eligible predator must live within 15 km, as the validation already requires.
- It drafts, validates and publishes in one step. The prey's agent is told privately that it
  carries a bounty, and how long it must last. Hunters still learn of it only through
  perception and clues.

**The operator's choice** (19 October, after the first demo). The owner asked to choose the prey
by hand in the admin panel (`arc-admin.html`), from:
- the animals agents steer;
- a search by number and species;
- a map of every living animal.

`POST /congo/admin/arc-bounties/drop` accepts any living animal of a hunted, unprotected
species that carries no bounty. Its rules record `selection: operator` or `random`.
- **Wild target:** an animal no agent steers can carry one too. Only a hunter's agent can win
  it; if it survives, the money goes back to the pool.
- **Trust:** the operator choosing a target, possibly next to an agent of their own, is trusted
  by design. The random button remains for bounties nobody chose.

**Adjudication** keeps 1D's rules, with the agent as payee:
- **Predator:** killed by predation before the deadline by an eligible predator that an agent
  with a proven wallet was steering at the kill, the agent not the prey's. That agent is paid.
- **Survived:** alive at the deadline and still steered by the agent that held it at publication.
  That agent is paid.
- **Void:** anything else; the reservation returns to the pool.

**Arc settlement** (`ArcBountyChain`):
- Publication sends `publish` with the commit.
- A decision sends `settle` or `voidBounty`, revealing the target and the record's keccak256.
- Every transaction is stored with its hash before broadcast and reconciled against the contract's
  view of the bounty, so a restart never sends one twice.
- With Arc on, the "funded" check reads the contract's unreserved pool, not the simulated ledger.

**Self-dealing.** One person running both a hunter and a prey agent could feed their own prey
to their own predator. So:
- the hunter's wallet must differ from the prey's;
- a hunter whose agent registered from the prey agent's network (the keyed hash of the
  registration address) is never paid, and the bounty returns to the pool;
- a random bounty goes only where a hunter from another network is near.

This is a weak check, since a second network is cheap. Before mainnet it needs real identity
limits: an X account's age, ERC-8004 identities, or a cap on what one owner can win.
`VANA_ARC_BOUNTIES_SAME_NETWORK_OK=1` lifts it for a testnet demo run from one machine. It is
refused on any chain but Arc Testnet.

## The demo

`tools/arc/bountyDemo.ts`, against a running Congo demo server:
1. Two test agents prove two test wallets.
2. One steers a leopard and one a blue duiker nearby.
3. A random bounty is published.
4. The leopard's agent hunts.
5. The script prints the publish and settle transactions on the Arc Testnet explorer, and the
   wallet that was paid.

## Not in this version

- **Automatic funding:** the treasury funds the pool by hand on testnet.
- **Mainnet:** needs the owner's approval and a legal read.
- **Paying both** an owner and an agent.

## Arc Testnet run (19 October 2026)

`WildsentiaBounties` is at
[`0x0741af75301873120BeC5cEba3c18b78a1b89050`](https://testnet.arcscan.app/address/0x0741af75301873120BeC5cEba3c18b78a1b89050).
Limits are 0.1 to 100 USDC. The pool was funded with 10 testnet USDC from the faucet, through
`tools/arc/bountySetup.ts`.

Both runs used `tools/arc/bountyDemo.ts` against the local Congo demo. Two agents proved two
wallets; one steered a leopard and one a blue duiker 16 m from it. Each run was a 1 USDC bounty
on the prey animal picked at random; the duiker was the only candidate, since no other agent
steered prey.

| Run | Publish | Decision | Paid |
|---|---|---|---|
| **Survive** (20 world minutes) | [0x4e8f…7e73](https://testnet.arcscan.app/tx/0x4e8fe53f1eabac9ac2f70d9806969de6e72056037f7b0a747b80cd8feaab7e73) | [0xf77e…565c](https://testnet.arcscan.app/tx/0xf77e264becdc9247eab66aa9b7dcbedfbe7693ce06fb5d8f8ded124737e8565c), survived | prey wallet 0 → 1 USDC |
| **Hunt** | [0x99a4…308b](https://testnet.arcscan.app/tx/0x99a4393a6b4032d8914cf04f0fa3ef05e5da2aa0fc6681ce160703d49c13308b) | [0x51ec…abdd](https://testnet.arcscan.app/tx/0x51ec0f97a90651282f1eb553d115c3f51d981c8f66b930a7b561e9b49d1babdd), predator | hunter wallet 0 → 1 USDC |

- **Reveal:** each decision revealed the target (keccak256 of `blue_duiker_2011`, with its salt)
  and stored the record's hash. The record is at `/congo/arc-bounties/:id/record`.
- **Pool:** it went from 10 to 8 USDC.
- **Demo setting:** both demo agents ran from one machine, so the run used
  `VANA_ARC_BOUNTIES_SAME_NETWORK_OK=1`.
- **The first publish failed:** the server stored a fractional world time (the hour being played
  is mid-hour). World times are now whole seconds, and the tests use a fractional clock.

## Alerts

People follow the hunts in a Discord channel and a Telegram chat
(`packages/server/src/notify/`). The engine's `announce` port tells the server when a bounty
goes live on chain and when it is paid or returned. Each event is alerted once.

**Settings**, all optional. Nothing is sent unless a destination or a dry run is set. A malformed
value stops the server, and the error never repeats it.

| Setting | What |
|---|---|
| `VANA_NOTIFY_DISCORD_WEBHOOK` | A Discord webhook, `https://discord.com/api/webhooks/<id>/<token>` (or `discordapp.com`) |
| `VANA_NOTIFY_TELEGRAM_BOT_TOKEN`, `VANA_NOTIFY_TELEGRAM_CHAT_ID` | A bot and the chat it posts to (Bot API `sendMessage`); both or neither |
| `VANA_PUBLIC_ORIGIN` | The site, for links (e.g. `https://wildsentia.lol`); no links without it |
| `VANA_NOTIFY_DRY_RUN=1` | Log each alert's text instead of sending it |

**Messages** are plain text, a few short lines each.
- **Live:** the amount in USDC, the species, the region, the deadline in world time and about
  how long that is in real time (at `host.worldHoursPerRealHour`), and a link to
  `<origin>/bounties.html#<bountyId>`. It never names the target animal or its agent: it says
  only what the public board says.
- **Decided:** who won (a hunter, the prey, or nobody, the money back to the pool) and the target,
  now revealed. A win also names the winning animal and the payee wallet, shortened
  (`0x1234…abcd`). Each carries the decision's explorer link and a watch link,
  `<origin>/#animal=<winner, else the target>`.

**Sending:**
- Each destination has its own queue, sent one at a time, about one alert a second.
- A 429, a 5xx or a network failure is retried after the wait the service asks for, else with
  backoff. After four tries, or when asked to wait over two minutes, the alert is logged once and
  dropped. Any other refusal is not retried.
- Requests time out after 10 s, and nothing throws into the engine.
- The webhook URL and the bot token are secrets (whoever holds one can post as the bot), so they
  are cut out of every log line.
- Discord gets plain `content` with every mention disabled (`allowed_mentions: { parse: [] }`).
  Telegram gets plain text with no `parse_mode`, so nothing needs escaping. Link previews stay on,
  so a link shows the board's share card.

## In the forest, and for agents (20 October 2026)

**In the forest (`/`):**
- **Chip:** while any bounty is live, a chip in the bar says how many and what they hold
  (`1 bounty live · 1 USDC`). On a phone it shows the count only.
- **Cards:** when a bounty goes live or is decided, a card pops up under the bar for 25 seconds:
  - a live one says its amount, species, region and real time left, never which animal;
  - a decided one says who won or that it went back to the pool.
  The browser remembers what it told, so each card shows once. A first visit shows what is live
  now, not old results. A hidden tab gets a browser notification where the viewer allowed them.
- **Panel:** the chip, a card's Details or the dock's Bounties button opens a panel. It lists
  every live bounty and the latest results, with the pool and links to the full board and the
  quick start.
- **Actions:**
  - **Fly to its region** moves the camera over the region's middle.
  - **Watch it** replays a decided bounty's record (`#bounty=<id>`).
  - Each card links its Arc transaction.
- **Polling:** every 20 seconds while the tab is visible. A server without Arc bounties shows none
  of this.

**For agents:**
- **Region:** each public bounty carries `area`, the region's middle and width in metres, so a
  viewer or an agent knows where to look. This is the same region the board already names.
- **`GET /agents/me/arc-bounties`** (an agent's signed request, observe rate) returns:
  - `live`: each live bounty as the public sees it, plus `youCanTake` (the animal it steers is
    one of the bounty's eligible predators) and `inYourRegion`;
  - `yours`: the bounty on the animal it steers, with its target and payout wallet. Only the
    agent the bounty was published for sees it, and only while it still steers that animal;
  - `results`: the latest ten, with `youWon`;
  - `you`: its animal, species, region and position.
  The guide documents it, and the MCP bridge has it as `get_arc_bounties`.
- **Notices:**
  - when a bounty goes live, every other agent steering an animal hears its amount, species and
    region (never which animal), with a pointer to the route;
  - when one is decided, the agent paid hears it and the wallet, with the transaction. The prey's
    agent, if another, hears that it ended.
  Each is told once per server run.

