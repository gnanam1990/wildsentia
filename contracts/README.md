# Wildsentia Challenges contract

`WildsentiaChallenges` holds USDC prizes for Wildsentia challenges on Arc
(design: [`docs/2026-10-09-challenges-design.md`](../docs/2026-10-09-challenges-design.md)).

A creator locks a prize behind a goal. The evaluator (the Wildsentia server) pays it to the first
player who meets the goal. If nobody does by the deadline plus one hour of grace, anyone can return
it to the creator. A locked prize can only ever go to a winner who is not the creator, or back to
the creator. Each challenge keeps the evaluator it was created under, so the owner, who appoints
the evaluator for new challenges, pauses payouts and sets prize limits, cannot move escrowed funds
(not even by appointing a new evaluator). Ownership is two-step and cannot be renounced. If an
evaluator key is compromised: pause payouts, appoint a new evaluator for new challenges, and let
that key's open prizes refund after their deadlines. A long pause can let a winner's payout window
close; the prize then refunds to the creator.

**Version 2** (19 November 2026, finding C1 of the security audit of 17 November) bounds
what a stolen evaluator key can take, as the bounty contract's version 2 did:
- **Daily cap.** At most `dailyPayoutCap` is paid in one UTC day (refunds do not count). It starts
  at one top prize; the owner may raise it, never below the top prize, and the top prize may not
  outgrow it.
- **Minimum open time.** A prize is paid only once its challenge has been open `minOpenSeconds`
  (10 minutes at first, at most a day), so a watcher can see it and the owner can pause. The server
  keeps a refused payout queued and pays it once the time has passed.
- **Revoke.** `revokeEvaluator(key)` ends a key for good: it can no longer pay, it cannot be
  appointed again, and its open prizes can be refunded at once.
- **Winner.** Neither the challenge's evaluator, the current evaluator nor the owner can win.

Version 1 is not upgraded in place: Challenges stay off (`VANA_CHALLENGES` unset) until version 2 is
deployed and the server points at it.

It is a small, reusable "first to finish" escrow: any app with an off-chain judge can use it.

`WildsentiaAttempts` is a separate, append-only public record of every attempt. It holds no funds.
Only its recorder (the same evaluator key) writes. Each attempt can be started once and ended once,
with its outcome (met, failed or void) and the keccak256 of its public record. The owner can move
the recorder role; ownership is two-step and cannot be renounced.

| Function | Who | What |
|---|---|---|
| `create(rulesHash, prize, deadline)` | creator | Locks `prize` from the creator's approved USDC |
| `createWithAuthorization(creator, rulesHash, prize, deadline, salt, validAfter, validBefore, signature)` | anyone (a relayer) | Locks the prize with the creator's signed EIP-3009 `ReceiveWithAuthorization`; the signed nonce must be `authorizationNonce(creator, rulesHash, prize, deadline, salt)`, so a relayer cannot change the terms. `ChallengeCreated` carries that nonce (zero for `create`), so a creation relayed by someone else still matches its pending record |
| `resolve(id, winner, resultHash)` | the challenge's evaluator | Pays the winner (never the creator, the escrow, an evaluator, the owner or `address(0)`) until `deadline + GRACE`, once open `minOpenSeconds` and within the day's cap; records the hash of the winning attempt's public log |
| `refund(id)` | anyone | After `deadline + GRACE`, or at once if the challenge's evaluator was revoked, returns the prize to the creator. Never paused |
| `revokeEvaluator`, `setDailyPayoutCap`, `setMinOpenSeconds` | owner | Version 2's rails, above |

Prizes are in USDC's 6-decimal ERC-20 units (1 USDC = `1000000`). On Arc, native gas amounts use
18 decimals; never mix the two.

## Develop

Needs Foundry v1.8.3 and Node 22.

```bash
npm ci --prefix contracts
(cd contracts && forge test)
node contracts/scripts/export-abi.mjs     # after changing the contract: refresh the server's ABI
```

`test/mocks/TestUSDC.sol` is a local stand-in for Arc's USDC (EIP-3009 receive and a blocklist),
used only by the tests.

## Deploy

`script/Deploy.s.sol` reads every setting from the environment (`CHALLENGES_USDC`,
`CHALLENGES_OWNER`, `CHALLENGES_EVALUATOR`, `CHALLENGES_MIN_PRIZE`, `CHALLENGES_MAX_PRIZE`) and
refuses an owner that is also the evaluator. It also refuses:
- a token that does not have 6 decimals;
- prize limits that do not fit or look like 18-decimal amounts (above 1,000,000 USDC);
- any chain but Arc Testnet (5042002), unless `CHALLENGES_MAINNET_APPROVED=true`. `script/DeployAttempts.s.sol` deploys
`WildsentiaAttempts` from `CHALLENGES_OWNER` and `CHALLENGES_EVALUATOR` (the recorder), with the
same refusal. Deploy to Arc Testnet with Arc Foundry; mainnet only after a legal review and the
owner's explicit approval.

## What the contracts trust

Both escrows are judged off-chain. A player, creator or sponsor trusts these, whatever the code
around them does:

- **The owner can withdraw what sponsors put in.** `WildsentiaBounties.withdraw` takes any
  unreserved USDC in the pool, whoever funded it. Only what open bounties hold is out of its reach.
  Challenges differ: a creator's prize can only go to a winner or back to the creator.
- **The evaluator chooses the payee.** The contracts cannot see the forest. They check that the
  payee is not the evaluator, the owner or the contract (nor, for a challenge, its creator), and they store the hash of the
  public record, so anyone can check a decision afterwards; they cannot check it beforehand. A
  stolen evaluator key can pay a wallet it controls, bounded by the daily cap and the minimum open
  time, until the owner pauses and revokes it.
- **The owner is trusted with the evaluator.** The owner appoints the evaluator, so the owner can
  appoint a key it controls and pay through it, within the same caps. It can also raise the caps
  and lower the minimum open time. Every such change is an event on chain;
  `tools/arc/watch.mjs` fails when the bounty contract's evaluator, owner, pause or pool is not as
  expected.
- **The daily cap resets at UTC midnight.** It counts per calendar day (`block.timestamp / 1 days`),
  not per rolling 24 hours, so up to two days' caps can be paid in the minutes either side of
  midnight.
- **Arc's USDC.** Both contracts hold USDC through its 6-decimal ERC-20 interface. The deploy tools
  (`script/Deploy.s.sol`, `tools/arc/mainnet.ts`) and the server refuse a token that does not count
  6 decimals. A blocklisted winner's payout reverts, and the prize stays refundable.
