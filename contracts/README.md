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

It is a small, reusable "first to finish" escrow: any app with an off-chain judge can use it.

| Function | Who | What |
|---|---|---|
| `create(rulesHash, prize, deadline)` | creator | Locks `prize` from the creator's approved USDC |
| `createWithAuthorization(creator, rulesHash, prize, deadline, salt, validAfter, validBefore, signature)` | anyone (a relayer) | Locks the prize with the creator's signed EIP-3009 `ReceiveWithAuthorization`; the signed nonce must be `authorizationNonce(creator, rulesHash, prize, deadline, salt)`, so a relayer cannot change the terms. `ChallengeCreated` carries that nonce (zero for `create`), so a creation relayed by someone else still matches its pending record |
| `resolve(id, winner, resultHash)` | the challenge's evaluator | Pays the winner (never the creator, the escrow or `address(0)`) until `deadline + GRACE`; records the hash of the winning attempt's public log |
| `refund(id)` | anyone | After `deadline + GRACE`, returns the prize to the creator. Never paused |

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
refuses an owner that is also the evaluator. Deploy to Arc Testnet with Arc Foundry; mainnet only
after a legal review and the owner's explicit approval.
