# The evaluator as a Circle developer-controlled wallet (22 October 2026)

## Why

On 21 October Railway disclosed a platform security incident and recommended rotating every
environment variable. The bounty evaluator's raw private key was one of them, so it was rotated
the same day (`setEvaluator`, and the old key's gas swept back).

The lasting fix is not to hold a raw evaluator key at all. The owner asked us to read and follow
Circle's docs:
- [Circle](https://developers.circle.com/)
- [CCTP](https://developers.circle.com/cctp)
- [Gateway](https://developers.circle.com/gateway)
- [Developer-Controlled Wallets](https://developers.circle.com/wallets/dev-controlled)

This is what we took from them.

## What Circle offers us

**Developer-controlled wallets (DCW): adopted.**
- **Arc support:** Arc Testnet is supported as `ARC-TESTNET` for EOA and SCA wallets
  ([supported blockchains](https://developers.circle.com/wallets/supported-blockchains)). Circle
  keeps the key.
- **What the server holds:**
  - an API key: testnet keys start `TEST_API_KEY:`, can be restricted to Wallets and limited to
    given IP addresses, and can be revoked in Console;
  - the entity secret: 32 bytes, registered in Console with a recovery file, rotatable there.
- **What each leak gives:** the API key alone cannot move funds, because every write needs a fresh
  entity-secret ciphertext. Both together give full control of the wallet. DCW has no policy
  engine, so the contract's limits stay the real guardrail.
- **How we call it:** `POST /v1/w3s/developer/transactions/contractExecution` with `walletId`,
  `contractAddress`, `callData`, `feeLevel`, `idempotencyKey` (a UUID v4) and
  `entitySecretCiphertext`.
  - A repeated idempotency key returns the first transaction (200), so nothing is sent twice.
  - The transaction is followed at `GET /v1/w3s/transactions/{id}`, which gives its state and
    `txHash`.
  - States: INITIATED, CLEARED, QUEUED, SENT, CONFIRMED, COMPLETE, FAILED, DENIED, CANCELLED and
    STUCK. A STUCK transaction is below the fee floor and blocks the wallet's later ones until it is
    accelerated or cancelled.
- **Gas:** an EOA pays its own gas in Arc's native USDC, so the wallet needs a few faucet USDC.
  Gas Station works only with smart-contract accounts, and Paymaster does not list Arc; we use
  neither.
- **Sign-only:** Circle signs and we broadcast. This is documented for `EVM-TESTNET` wallets, not
  `ARC-TESTNET`, so we do not use it.

**CCTP: not adopted.** CCTP burns USDC on one chain and mints it on another. Arc is domain 26, a
source with standard transfer only. The owner can use it by hand to bring USDC from another chain
into the pool; the server needs no code for it.

**Gateway: not adopted.** Gateway gives one USDC balance across chains, and Arc Testnet is
supported. Our pool is an escrow contract on Arc alone, so Gateway has nothing to add.

## How it works in the code

- **`packages/server/src/arcBounties/circle.ts`** (`circleSigner`): Circle's REST API.
  - Each write encrypts the entity secret anew (RSA-OAEP with SHA-256, under Circle's public key
    from `GET /v1/w3s/config/entity/publicKey`).
  - Failures are logged without the request body.
  - `idempotencyUuid(text)` draws a UUID v4 from a text, so the same text always gives the same key.
- **`chain.ts`:** the bounty chain takes either a raw key or an `ExternalSigner`.
  - Reads stay on viem over the RPC.
  - With a signer, `submit` first runs a gas estimate from the wallet, so a contract refusal is
    named before anything reaches Circle. It then sends under the idempotency key and returns
    `circle:<id>`.
  - `receipt` and `hashOf` follow the Circle transaction.
- **`engine.ts`** sends one Circle transaction per call and attempt:
  - the key is drawn from the contract, bounty, call and the previous attempt's reference;
  - a transaction still in flight is waited on, never sent again;
  - only a failed one is tried again, under a new key;
  - it polls every 3 s for up to 30 s, then leaves the rest to `processPending`;
  - once a transaction is mined, its chain hash replaces Circle's reference, so explorer links work.
- **Start-up check:** before each publish, the server confirms the contract's `evaluator()` is the
  Circle wallet. If it is not, it refuses.

### Settings

| Variable | |
|---|---|
| `VANA_ARC_BOUNTIES_SIGNER` | `circle`, or `key` (the default), which uses `VANA_ARC_BOUNTIES_EVALUATOR_KEY` |
| `VANA_CIRCLE_API_KEY` | `TEST_API_KEY:…`. On Arc Testnet, a key without this prefix is refused. |
| `VANA_CIRCLE_ENTITY_SECRET` | 64 hex characters |
| `VANA_CIRCLE_WALLET_ID`, `VANA_CIRCLE_WALLET_ADDRESS` | from the setup tool |
| `VANA_CIRCLE_FEE_LEVEL` | LOW, MEDIUM (default) or HIGH |

## Setting it up

**By the owner, in [Circle's Console](https://console.circle.com)** (we do not create accounts or
handle these secrets for the owner):
1. Create an account.
2. Create a **testnet API key**, restricted to Wallets (read and write). Add an IP allowlist if
   Railway can give fixed outgoing addresses.
3. Generate a 32-byte entity secret, for example with `openssl rand -hex 32`. Register it in
   Console. Keep the recovery file offline, apart from the secret.
4. Put both in a private file:

       VANA_CIRCLE_API_KEY=TEST_API_KEY:…
       VANA_CIRCLE_ENTITY_SECRET=…

   For example `~/.wildsentia/circle-arc.env`, with mode 600.

**Then:**
1. Run `npx tsx tools/arc/circleSetup.ts ~/.wildsentia/circle-arc.env ~/.wildsentia/arc-testnet-wallets.env`.
   It makes the wallet set and one `ARC-TESTNET` EOA wallet, writes their ids and the address back
   into the file, and shows the wallet's gas.
2. Fund the wallet's gas at [faucet.circle.com](https://faucet.circle.com) (Arc Testnet).
3. Run the same command with `--appoint`. It calls `setEvaluator(wallet)` from the owner key.
4. Set the Circle variables on Railway and remove `VANA_ARC_BOUNTIES_EVALUATOR_KEY`. Redeploy.
5. Change `ARC_WATCH_EVALUATOR` in `.github/workflows/arc-watch.yml` to the Circle wallet's address.

## Tests

`packages/server/test/arcBounties.test.ts` runs a stand-in for Circle's API in front of anvil. It
holds the evaluator key and sends for it, and the test checks that:
- a bounty is published and paid through it;
- each write carries a fresh ciphertext that opens to the entity secret;
- an idempotency key used twice returns the first transaction and sends nothing new;
- a call the contract would refuse never reaches Circle;
- the chain hash is what is kept for each bounty.
