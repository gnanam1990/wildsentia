# Wildsentia Challenges on Arc Testnet (plan 4 runbook)

Arc Testnet only, with testnet USDC from the faucet. Mainnet waits for a legal review and the owner's
explicit approval; the deploy scripts refuse any other chain unless `CHALLENGES_MAINNET_APPROVED=true`.

## 0. Already checked (read-only)

```bash
npx tsx tools/arc/check-testnet.ts
```

This checks chain 5042002 and the USDC token at `0x3600000000000000000000000000000000000000`:
- 6 decimals;
- EIP-712 domain `USDC` / `2`;
- `receiveWithAuthorization` with a bytes signature.

Run it again before deploying.

## 1. Two wallets (the owner does this; never paste keys into chat)

| Wallet | Job | Holds |
|---|---|---|
| Owner | can appoint the evaluator for new challenges, pause payouts, set prize limits, move the recorder | a little testnet USDC for gas |
| Evaluator | the server's key: relays creations, pays winners, refunds, writes attempt records | testnet USDC for gas only (Arc gas is paid in USDC) |

Keep the owner's key off the server. Store keys in Foundry's encrypted keystore:

```bash
cast wallet import wildsentia-owner --interactive
```

```bash
cast wallet import wildsentia-evaluator --interactive
```

Fund both from the Circle testnet faucet. Gas is USDC on Arc; a few USDC covers many transactions.

## 2. Deploy both contracts

```bash
cd contracts && npm ci && forge build
```

```bash
export ARC_RPC=https://rpc.testnet.arc.io
export CHALLENGES_USDC=0x3600000000000000000000000000000000000000
export CHALLENGES_OWNER=<owner address>
export CHALLENGES_EVALUATOR=<evaluator address>
export CHALLENGES_MIN_PRIZE=1000000
export CHALLENGES_MAX_PRIZE=100000000
```

The prizes are in 6-decimal units: `1000000` is 1 USDC, and `100000000` is 100 USDC.

```bash
forge script script/Deploy.s.sol --rpc-url $ARC_RPC --account wildsentia-owner --broadcast
```

```bash
forge script script/DeployAttempts.s.sol --rpc-url $ARC_RPC --account wildsentia-owner --broadcast
```

Note both addresses and the challenges contract's deployment block (from `broadcast/…/run-latest.json`).

## 3. Server settings (Railway, service `server`)

| Variable | Value |
|---|---|
| `VANA_CHALLENGES` | `1` |
| `VANA_CHALLENGES_RPC_URL` | `https://rpc.testnet.arc.io` |
| `VANA_CHALLENGES_CHAIN_ID` | `5042002` |
| `VANA_CHALLENGES_CONTRACT` | the WildsentiaChallenges address |
| `VANA_CHALLENGES_ATTEMPTS_CONTRACT` | the WildsentiaAttempts address |
| `VANA_CHALLENGES_USDC` | `0x3600000000000000000000000000000000000000` |
| `VANA_CHALLENGES_USDC_DOMAIN_NAME` / `_VERSION` | `USDC` / `2` |
| `VANA_CHALLENGES_EVALUATOR_KEY` | the evaluator's private key (a sealed Railway variable) |
| `VANA_CHALLENGES_FROM_BLOCK` | the deployment block |
| `VANA_CHALLENGES_ADMIN_TOKEN` | 64 random characters |
| `VANA_CHALLENGES_EXPLORER_URL` | `https://explorer.testnet.arc.io` |
| `VANA_PUBLIC_ORIGIN` | `https://wildsentia.lol` (the link in challenge posts) |
| `VANA_X_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | from the X app; redirect `https://wildsentia.lol/api/accounts/x/callback` |

On start, the server refuses to run if:
- the key is not the challenges contract's evaluator;
- the key is not the attempts contract's recorder;
- the database holds another contract's challenges.

## 4. End-to-end journeys (testnet USDC only)

1. **Created:** sign in with X, link a wallet, and create a 1 USDC survive challenge from `/challenge-new.html`. The prize leaves the creator's wallet, and the challenge appears on `/challenges.html` with its "Created on Arc" link.
2. **Won:**
   1. A second account (or an agent with a proven wallet) accepts.
   2. It meets the goal (a 1-day survive goal is 2 real hours at the island's clock; a hunt goal is faster).
   3. The winner is paid, the challenge shows "Won and paid", and both attempt records are on chain.
3. **Refunded:** a challenge nobody wins refunds to its creator an hour after its deadline.
4. **Rules:** an attempt that breaks a rule ends with its reason, and its record is on chain.
5. **Payouts paused:** while the owner has paused payouts, a met attempt stays `won`. After the pause is lifted, it is paid if still within the window; otherwise it refunds.

## 5. If something goes wrong

- **The evaluator key leaked:**
  1. As the owner, call `setResolvePaused(true)`.
  2. Appoint a new evaluator for new challenges.
  3. Let the old key's open prizes refund after their deadlines.
  4. Move the attempts recorder too (`setRecorder`).
- **The recorder was moved while the server runs:** record operations fail with `NotRecorder`. Restart the server with the new key. Records that failed are not retried (each attempt is recorded at most once), so note them; the attempts' records stay public on the server.
