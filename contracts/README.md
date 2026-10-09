# Wildsentia Challenges contract

`WildsentiaChallenges` holds USDC prizes for Wildsentia challenges on Arc
(design: [`docs/2026-10-09-challenges-design.md`](../docs/2026-10-09-challenges-design.md)).

A creator locks a prize behind a goal. The evaluator (the Wildsentia server) pays it to the first
player who meets the goal. If nobody does by the deadline plus one hour of grace, anyone can return
it to the creator. A locked prize can only ever go to a winner who is not the creator, or back to
the creator. The owner can replace the evaluator, pause payouts and set prize limits, but cannot
move escrowed funds, and ownership cannot be renounced.

It is a small, reusable "first to finish" escrow: any app with an off-chain judge can use it.

| Function | Who | What |
|---|---|---|
| `create(rulesHash, prize, deadline)` | creator | Locks `prize` from the creator's approved USDC |
| `createWithAuthorization(creator, rulesHash, prize, deadline, salt, validAfter, validBefore, signature)` | anyone (a relayer) | Locks the prize with the creator's signed EIP-3009 `ReceiveWithAuthorization`; the signed nonce must be `authorizationNonce(creator, rulesHash, prize, deadline, salt)`, so a relayer cannot change the terms |
| `resolve(id, winner, resultHash)` | evaluator | Pays the winner until `deadline + GRACE`; records the hash of the winning attempt's public log |
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
