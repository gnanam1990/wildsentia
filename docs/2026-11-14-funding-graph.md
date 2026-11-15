# The funding-graph check on Arc bounties (14 November 2026)

## Why

A Congo bounty pays the hunter whose predator kills the target, or the prey's agent if it
survives. One person running both agents could feed their own prey to their own predator.

Until now the guard was:
- different wallets;
- different registration networks;
- a crowd of alike prey to hide the target in.

The design doc already called the network check weak, since a second network is cheap.

Circle Research's Anduin paper (Ramji, Vander Vos, Zeng and Le, 3 November 2026) makes the same
point about agent marketplaces. Ratings and usage counts can be faked for under a cent. Ranking by
who actually paid whom makes the same attack about 23 times costlier. The check here applies that
idea to bounties: money that moved between wallets says more about who owns them than a network does.

## The rule

The hunter's wallet is linked to the prey's wallet when, among their USDC transfers on chain:

| Link | Meaning |
|---|---|
| direct | One wallet sent to the other. |
| funder | One address sent to both. |
| cash-out | Both sent to one address. |

The prey's wallet means the one it held at publication, and the wallet of whoever held it at the kill.

**Which flows count.** A flow is everything one address sent another, summed.
- **Most flows** count once they add up to at least `VANA_ARC_BOUNTIES_FUNDING_MIN_USDC` (default
  0.5). Because it is a total, funding split into many small transfers still counts.
- **A payment from the hunter's wallet to the prey's** counts at any amount, since nobody else
  can make the hunter send.
- **Through a third address**, a shared funder or cash-out, both sides need the minimum. Otherwise
  a hunter's small payment to some service could be paired by the prey's owner paying it too.

A transfer between the two wallets appears in both their lists and is counted once. It is told
apart by its transaction hash and log index. If the explorer gives an item without them, the whole
read fails and the decision waits; two transfers are never guessed to be one.

**What does not count as a link.** A public hub joins strangers, so it links nobody. Only an
address on the list is a hub:
- **Always:** the bounty contract, which pays every winner; the evaluator; the USDC system contract.
- **On Arc Testnet:** the faucet `0x70E3…Af8e`, which has paid millions of wallets, and version 1 of
  the bounty contract `0x0741…9050`, which paid the first winners.
- **Any address the operator adds** with `VANA_ARC_BOUNTIES_FUNDING_IGNORE`.

Nothing an address does on chain makes it a hub. A review on 15 November found that a colluder
could otherwise hide their link:
- by funding both wallets through a contract they deploy, when every contract counted as a hub; or
- by padding their own address past 1000 token transfers with spam, when a busy address counted.

The cost of a list is that an unlisted public address, say another app that pays many people, can
link two honest wallets. Then a kill is voided, not paid wrongly: its record names the address
(`via`), and the operator can list it.

On Arc a native USDC payment is listed by the explorer as a token transfer of `0x3600…0000`. So
the USDC transfer list covers both native USDC and ERC-20 USDC.

**Why only USDC, and a minimum for others' flows.** The check must not be turned against an honest
hunter.
- **Other tokens can be forged.** Any contract can log a Transfer event that names any sender. A
  spam token could "show" the prey paying the hunter, so other tokens are never read. The explorer
  is asked for USDC only, and each item is checked again. USDC is the chain's own system contract,
  so its transfers cannot be forged.
- **Dust does not count, unless the hunter sent it.** Without a minimum, anyone could send dust from
  one address to both a hunter and a prey and void the hunter's kills. The prey's owner could do
  the same by sending the hunter a cent. With the minimum, each false link costs the griefer at
  least 0.5 USDC per flow, and the money goes to the people they meant to harm. Only the hunter's
  own payment to the prey needs no minimum, since only the hunter can make it.

**A wallet's whole history is read.** The explorer gives transfers newest first, 50 a page. Reading
only the first pages would let a colluder push the old funding transfer out of sight with newer
dust, so every page is read. A wallet with more than `VANA_ARC_BOUNTIES_FUNDING_MAX_TRANSFERS`
(default 2000) USDC transfers is not read in part: the read fails, and the decision waits as below.
Someone who sends a hunter 2000 transfers can so hold back its kills; that costs 2000 transactions,
the bounty returns to the pool rather than going to anyone, and the operator can raise the cap.

**What happens when a link is found:**
- **A linked kill is never paid.** The bounty goes back to the pool. Its record (hashed and
  revealed on chain) carries `refused: { reason: 'funding_linked', how, via }`.
- **A linked hunter does not count as the hunter near a random bounty.**
- **If the explorer cannot be read, nothing is paid.** The decision waits for a later pass, every
  10 s. If the explorer stays down to the bounty's expiry, the bounty returns to the pool. A
  candidate hunter whose link cannot be read is not counted.

**One-machine demos.** `VANA_ARC_BOUNTIES_SAME_NETWORK_OK=1` (Arc Testnet only) also lifts this check.

## Where it reads

- **On Arc Testnet,** from the explorer, as below.
- **On Arc Mainnet,** whose explorer refuses servers, from the server's own index of USDC transfers
  read from the RPC (docs/2026-11-15-arc-mainnet-readiness.md). That index keeps a wallet's whole
  history, summed per pair of addresses, so the 2000-transfer cap below does not apply there.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `VANA_ARC_BOUNTIES_FUNDING_CHECK` | on | `off` turns the check off. |
| `VANA_ARC_BOUNTIES_FUNDING_API` | `https://explorer.testnet.arc.io/api/v2` on Arc Testnet | A Blockscout API v2 base. Any other chain must name its own. |
| `VANA_ARC_BOUNTIES_FUNDING_IGNORE` | none | More hub addresses, comma-separated. |
| `VANA_ARC_BOUNTIES_FUNDING_MAX_TRANSFERS` | 2000 | A wallet with more USDC transfers is not read, and its decisions wait. |
| `VANA_ARC_BOUNTIES_FUNDING_MIN_USDC` | 0.5 | Every flow counts from this total, except the hunter's payment to the prey. |

**Reads and caching:**
- A wallet's transfers are kept for a minute (15 s from the mainnet index), so funding sent just
  before a kill is still seen.
- A wallet whose read failed is not asked again for a minute.
- If the explorer is down (unreachable, slow past 10 s, or answering with an error), every read
  fails at once for a minute. A bounty pass then does not wait on the explorer for each wallet in
  turn and hold up the other decisions.

## Checked against Arc Testnet

Run on 14 November 2026 against the live explorer, with this project's own wallets:

| Wallets | Result | Why |
|---|---|---|
| Demo hunter and demo prey | not linked | Both were paid only by the bounty contracts (both versions are listed). |
| Owner and treasury | linked, direct | The treasury funded the owner. |
| Treasury and the Circle evaluator wallet | not linked | Both took 20 USDC from the faucet, a hub. |

Run again on 15 November with the explicit hub list, with the same results. Without version 1 of the
bounty contract on the list, the demo hunter and prey were linked through it, which is why it is
listed.

## What it does not stop

- **Fresh wallets.** A wallet with no history has no links. Two brand-new wallets that never touch
  each other, or a common address, pass. The check raises the cost of self-dealing; it does not end it.
- **Paths of two hops or more.** A pays B, B pays the prey, A funded the hunter: this is not
  followed. Only direct transfers and one shared address count.
- **Laundering through a hub.** A deposit to an exchange and a withdrawal to both wallets passes.
- **Small funding to both sides.** A colluder who keeps each flow under the minimum, and never has
  the hunter pay the prey, passes. Agent wallets need no gas to be paid,
  so colluding wallets meet chiefly when winnings are gathered. Winnings are at least 1 USDC, and
  the prey side's cash-out then counts.
- **Paid griefing.** Someone can still link a hunter to a prey by paying both wallets the minimum,
  or by pairing, with the prey's wallet, an address the hunter once paid at least the minimum. Each
  such link is costly, is visible on chain, and gives money away.

**Before mainnet,** the design's other identity limits still apply:
- a cap on what one owner can win;
- an X account's age, or ERC-8004 identities;
- Anduin-style scoring, which gives a wallet weight only through its trusted payment paths, so
  that a fresh wallet earns little until money it did not send itself reaches it.
