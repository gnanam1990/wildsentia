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
