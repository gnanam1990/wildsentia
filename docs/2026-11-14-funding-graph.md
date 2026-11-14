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

The hunter's wallet is linked to the prey's wallet when, among their USDC transfers on chain of at
least `VANA_ARC_BOUNTIES_FUNDING_MIN_USDC` (default 0.5):

| Link | Meaning |
|---|---|
| direct | One wallet sent to the other. |
| funder | One address sent to both. |
| cash-out | Both sent to one address. |

The prey's wallet means the one it held at publication, and the wallet of whoever held it at the kill.

**What does not count as a link.** A public hub joins strangers, so it links nobody:
- **A contract.** The bounty contract pays every winner.
- **An address the operator lists.** The bounty contract, the evaluator and the USDC system contract
  are always listed.
- **A busy address.** One with more than `VANA_ARC_BOUNTIES_FUNDING_HUB_TRANSFERS` token transfers
  (default 1000). Arc Testnet's faucet `0x70E3…Af8e` has made about 4 million.

On Arc a native USDC payment is listed by the explorer as a token transfer of `0x3600…0000`. So
the USDC transfer list covers both native USDC and ERC-20 USDC.

**Why only USDC, and only above the minimum.** The check must not be turned against an honest
hunter.
- **Other tokens can be forged.** Any contract can log a Transfer event that names any sender. A
  spam token could "show" the prey paying the hunter, so other tokens are never read. The explorer
  is asked for USDC only, and each item is checked again. USDC is the chain's own system contract,
  so its transfers cannot be forged.
- **Dust does not count.** Without a minimum, anyone could send dust from one address to both a
  hunter and a prey, and void the hunter's kills. With it, each false link costs the griefer at
  least 0.5 USDC per wallet, and the money goes to the people they meant to harm.

**What happens when a link is found:**
- **A linked kill is never paid.** The bounty goes back to the pool. Its record (hashed and
  revealed on chain) carries `refused: { reason: 'funding_linked', how, via }`.
- **A linked hunter does not count as the hunter near a random bounty.**
- **If the explorer cannot be read, nothing is paid.** The decision waits for a later pass, every
  10 s. If the explorer stays down to the bounty's expiry, the bounty returns to the pool. A
  candidate hunter whose link cannot be read is not counted.

**One-machine demos.** `VANA_ARC_BOUNTIES_SAME_NETWORK_OK=1` (Arc Testnet only) also lifts this check.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `VANA_ARC_BOUNTIES_FUNDING_CHECK` | on | `off` turns the check off. |
| `VANA_ARC_BOUNTIES_FUNDING_API` | `https://explorer.testnet.arc.io/api/v2` on Arc Testnet | A Blockscout API v2 base. Any other chain must name its own. |
| `VANA_ARC_BOUNTIES_FUNDING_IGNORE` | none | More hub addresses, comma-separated. |
| `VANA_ARC_BOUNTIES_FUNDING_HUB_TRANSFERS` | 1000 | Above this many token transfers, an address is a hub. |
| `VANA_ARC_BOUNTIES_FUNDING_MIN_USDC` | 0.5 | Smaller USDC transfers do not count. |

**Reads and caching:**
- A wallet's transfers come from up to four pages of 50, newest first.
- They are kept for 10 minutes, as is an address's hub status.
- A failed read is not kept.

## Checked against Arc Testnet

Run on 14 November 2026 against the live explorer, with this project's own wallets:

| Wallets | Result | Why |
|---|---|---|
| Demo hunter and demo prey | not linked | Both were paid only by the bounty contracts. |
| Owner and treasury | linked, direct | The treasury funded the owner. |
| Treasury and the Circle evaluator wallet | not linked | Both took 20 USDC from the faucet, a hub. |

## What it does not stop

- **Fresh wallets.** A wallet with no history has no links. Two brand-new wallets that never touch
  each other, or a common address, pass. The check raises the cost of self-dealing; it does not end it.
- **Paths of two hops or more.** A pays B, B pays the prey, A funded the hunter: this is not
  followed. Only direct transfers and one shared address count.
- **Laundering through a hub.** A deposit to an exchange and a withdrawal to both wallets passes.
- **Old history.** USDC transfers past the first 200 are not read.
- **Small funding.** Transfers under the minimum are not read. Agent wallets need no gas to be
  paid, so two colluding wallets meet chiefly when winnings are gathered, and winnings are at least
  1 USDC.
- **Paid griefing.** Someone willing to pay the minimum to both wallets, or to send from the prey's
  wallet to an address the hunter once paid, can still link them. Each such link is costly, is
  visible on chain, and gives money to the people linked.

**Before mainnet,** the design's other identity limits still apply:
- a cap on what one owner can win;
- an X account's age, or ERC-8004 identities;
- Anduin-style scoring, which gives a wallet weight only through its trusted payment paths, so
  that a fresh wallet earns little until money it did not send itself reaches it.
