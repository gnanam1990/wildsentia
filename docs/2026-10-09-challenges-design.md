# Wildsentia Challenges: design

Status: draft for review, 9 October 2026.

## 1. What it is

People sign in with X, lock a USDC prize on Arc and challenge others to keep a wild animal
alive (or make a hunt, or escape predators) on the forest island. Anyone can take a challenge
for free, playing the animal themselves in the browser or through their AI agent. The first
player to meet the goal is paid the prize automatically. If nobody meets it by the deadline,
the prize goes back to the creator. The prize can go nowhere else.

Decisions already made (9 October 2026):

| Question | Decision |
|---|---|
| Who it is for | AI agent builders first; human X users play too |
| Who pays | Only the challenge creator. Players never pay or stake anything |
| Who plays | Both humans (browser controls) and AI agents (existing agent API) |
| Several players on one challenge | The first to meet the goal takes the whole prize |
| Who may create | Anyone with a linked X account and wallet, within limits |
| Where it is played | The live shared world (sandboxed replays may come later) |
| Goals | Fixed templates only, so the server can judge them without argument |
| Network | Arc Testnet first. Mainnet only after a legal review and the owner's approval |

The world is presented as a forest island somewhere in the world, never as a real country's forest.

## 2. What the existing code gives us, and what it does not

From a read of the live layer (`packages/server/src/live/`) and the sim:

- Agents already register, take an eligible adult (`World.#blockFor`, `packages/sim/src/world.ts:897`),
  steer it (move, go to, graze, drink, rest, feed, hunt, climb, say) and lose it on death,
  capture, idle (15 minutes without a command), release or giving birth (`liveLayer.ts:620`).
  Every ended life is stored in `live_lives`.
- Wild predators already hunt agents' animals in real time (`liveLayer.ts:533`).
- Observable state per animal: drives (hunger, thirst, fatigue, fear), age, life stage, stamina,
  wounds, illness, offspring and dependants (`packages/shared/src/types/agent.ts:99`). Live hunts
  are `hunt` events with `conditions.source='live'` and `predatorSteered`/`preySteered`, so a failed
  hunt on a steered prey is an escape.
- A world day is 2 real hours at `WORLD_HOURS_PER_REAL_HOUR=12`.
- There is **no human control of an animal**, **no X sign-in**, **no contract code** and **no
  chain writes** anywhere.
- **A possessed life cannot be replayed.** Live inputs are not logged and the live layer uses
  `Math.random` and `Date.now`. So verification in this version is a published, signed event log
  plus the server's word, not an independent replay (section 7).
- **"Raise a young" cannot be a goal yet.** A possessed mother is released at birth and a parent
  with dependants cannot be taken. It is left out of the first version.

## 3. Goal templates (first version)

| Template | Who can take it | Met when |
|---|---|---|
| `survive` | Any eligible species named by the creator | The player's animal is alive and still possessed `days` world days after the attempt started (`days` 1, 3 or 7, i.e. 2, 6 or 14 real hours) |
| `hunt` | Tiger, leopard or dhole | A live `hunt` event with `predatorSteered` = the player's animal and outcome success |
| `escape` | Any prey species named by the creator | `count` (1–5) live `hunt` events with `preySteered` = the player's animal and outcome failure, while it stays alive |

Each challenge also has a deadline (1–14 days in real time) by which an attempt must meet its goal.
Templates are versioned (`survive@1`, ...). The template id and its parameters are hashed and the
hash is stored on chain at creation, so the rules a creator paid for cannot change afterwards.

## 4. How it works, end to end

```
 creator ─ X sign-in + wallet link ─> picks template, prize, deadline
         ─ signs one EIP-3009 authorization ─> server relays create() ─> USDC escrowed on Arc
         ─> challenge page + X post draft (owner approves posting)

 player  ─ X sign-in + wallet (human) or signed agent API (AI) ─> accept challenge
         ─> gets a free eligible animal in the live world ─> plays
         ─> server watches the goal ─> first to meet it ─> server calls resolve(winner) on Arc
                                                         ─> prize paid to the winner's wallet

 nobody wins by deadline + grace ─> anyone (normally the server) calls refund() ─> back to creator
```

### Attempts
- One open attempt per player at a time, across all challenges. An attempt is a possession
  started through the challenge, so it uses the existing live-layer possession and its rules
  (including the cap of a fifth of each species). A human account plays through a live-layer
  identity of its own (`kind = 'human'`), so the live layer treats humans and agents alike.
- An attempt ends as `met` (goal reached, the player keeps the animal), `failed` (death, capture,
  idle release, the player released it, the deadline passed) or `void` (the animal gave birth,
  the server restarted mid-attempt and could not restore it, or the challenge closed).
- The animal is assigned by the existing possession rules (a free eligible adult of the species).
  The starting state (position, drives, age, stamina) is recorded in the attempt.
- The first `met` attempt by completion time wins. If two attempts are met in the same live tick,
  the one that started first wins.

### Humans in the live world
- The 15-minute idle rule stays, but the play page sends a presence ping once a minute while
  it is open and visible, and that counts as a command. Closing the tab still lets the animal go
  after 15 minutes.
- Long `survive` challenges are realistically for agents. That is accepted, not worked around.

## 5. The contract: `WildsentiaChallenges`

A new Foundry package, `packages/contracts`, built with Arc Foundry. It follows the rules of
ERC-8183 (fixed evaluator, refunds nobody can block, no fee on refunds) but fits "anyone may
attempt, the first to finish is paid", which ERC-8183 cannot express because it needs the provider
before funding. ERC-8183 also has no mainnet address in Arc's docs today.

```solidity
struct Challenge { address creator; uint96 prize; uint64 deadline; bytes32 rulesHash; Status status; address winner; }
enum Status { None, Open, Resolved, Refunded }

function createWithAuthorization(bytes32 rulesHash, uint96 prize, uint64 deadline,
    address from, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature) returns (uint256 id);
function resolve(uint256 id, address winner, bytes32 resultHash);   // evaluator only
function refund(uint256 id);                                          // anyone, after deadline + GRACE
function setEvaluator(address next);                                  // owner only
function setResolvePaused(bool paused);                               // owner only; never affects refund
```

- **Escrow intake:** `createWithAuthorization` calls USDC `receiveWithAuthorization` (the payee
  must be the caller, so a relayed authorization cannot be front-run elsewhere). The creator
  signs once and pays no gas; the server's relayer submits it.
- **Payout:** `resolve` only while `Open`, only before `deadline + GRACE` (1 hour, for an attempt
  met just before the deadline), only to `winner != creator` and `winner != address(0)` (Arc
  reverts zero-address sends). It records `resultHash`, the hash of the attempt's published log.
- **Refund:** after `deadline + GRACE`, any caller can return the prize to the creator. Pausing
  never touches refunds.
- **Invariants:**
  - The contract's USDC balance always equals the sum of `Open` prizes.
  - Each challenge pays out exactly once, to its winner or its creator.
  - The owner can change the evaluator and pause payouts. The owner can never move escrowed funds.
- **Limits on chain:** a maximum prize (owner-set; 100 USDC on testnet) and a deadline 1–14 days
  from creation.
- **Decimals:** prizes use the USDC ERC-20 interface at `0x3600…0000` (6 decimals). Native gas
  amounts are 18 decimals. Server code keeps the two apart and reads `decimals()` at start.
- Open source with tests and a README, as a reusable "first to finish" escrow for Arc builders.

## 6. Server

New module `packages/server/src/challenges/`, off unless configured (`VANA_CHALLENGES=1` plus the
settings below; partial configuration is an error).

| Part | Job |
|---|---|
| `accounts` | X sign-in (OAuth 2.0 with PKCE, scope `users.read tweet.read`) and SIWE wallet link. A session is an HttpOnly, Secure, SameSite=Lax cookie; only its hash is stored |
| `store` | PostgreSQL tables (migration `019_challenges.sql`): `accounts`, `challenges`, `challenge_attempts`, `challenge_chain_ops` |
| `chain` | viem public and wallet clients for Arc: relay `createWithAuthorization`, send `resolve` and `refund`, read events. Gas fees are fetched fresh before every transaction |
| `engine` | Starts attempts through the live layer, watches goals on each live tick and on `hunt` events, ends attempts, picks the winner |
| `routes` | Public: list and detail. Signed-in: create, accept, play commands, presence. Agent: `POST /agents/me/challenges/:id/accept` with the existing Ed25519 signing |
| `social` | Drafts X posts (created, won, refunded) into the existing social outbox. Nothing posts without the owner's approval there |

**Chain operations are durable.** Each `resolve`/`refund`/relay is a row written before sending
(`pending → sent(txHash) → confirmed | failed`). On restart, `sent` rows are checked by receipt
before any retry, so the same payout is never sent twice. Arc's finality is under a second, so
a receipt with status 1 is final.

**Blocklisted addresses.** On Arc a USDC transfer to or from a blocklisted address reverts. A
`resolve` to a blocklisted winner therefore fails; the attempt is recorded as met but unpaid, and
the prize returns to the creator through `refund` after the deadline. A blocklisted creator cannot
create (the authorization's transfer reverts). If a creator is blocklisted after creating, the
refund cannot be paid until that is lifted; this is stated on the create page.

**Who is paid.** A human winner is paid to their linked wallet. An AI agent is paid to the wallet
its builder proved at registration. An agent with no proven wallet can play but cannot win a prize.

**Abuse limits (all settings):**
- An account may create 3 challenges a day.
- An X account must be at least 30 days old to create or win.
- A prize must be at least 1 USDC.
- The creator, the creator's wallet and any agent registered with that wallet cannot take the
  creator's challenge. This blocks the obvious self-dealing, not someone running several
  identities; that limit is stated publicly.

**Secrets:** the evaluator/relayer key (`VANA_CHALLENGE_EVALUATOR_KEY`) and the X client secret
come from the environment, are never logged and never sent to the client. The evaluator wallet
holds only gas money.

## 7. Trust, stated plainly

- The server decides who met a goal. It could lie, but the prize can still only go to a
  non-creator winner or back to the creator. The server can never take it.
- A compromised evaluator key could pay open prizes to an attacker's address. Limits: the
  maximum prize, the owner's pause, and a small evaluator balance (gas only).
- For every attempt the server publishes a log at `/api/challenges/:id/attempts/:attempt`:
  start state, every command with its time, the relevant world events and the outcome. The
  `resultHash` on chain is the hash of the winner's log, so the log cannot be changed afterwards.
  This is evidence, not an independent replay; making the live layer replayable is later work.

## 8. Client

- **Challenges page** (`/challenges`): open challenges with prize, goal, deadline and attempt
  count; won and refunded ones with links to their Arc transactions.
- **Create flow:** sign in with X, link a wallet (SIWE on Arc), pick a template and its parameters,
  set the prize and deadline, sign the authorization, then see the created challenge.
- **Play view:** the existing observer following the player's animal, plus a control panel:
  click the ground to walk or run there; buttons for graze, drink, rest, climb; hunt by tapping a
  prey animal; drive bars, stamina, goal progress, and warnings when a predator is chasing.
  It works on phones. Every state the server can send (assigned, waiting in a queue, chased, idle
  warning, met, failed, void, disconnected) has its own clear message.
- **Agents:** the "Play as an AI agent" page and `client.mjs` gain `challenges` and
  `accept <id>` commands.

## 9. Arc and Circle features: what we use, when, and why

Checked against `docs.arc.io` (index read 9 October 2026).

**First version**

| Feature | Use |
|---|---|
| USDC escrow in our own contract | The prize (section 5) |
| EIP-3009 authorization, relayed by our server | The creator locks the prize with one signature and no gas (`docs.arc.io/integrate/relayers-and-paymasters/eip-3009-relayer`) |
| Sub-second deterministic finality | A winner is paid the moment the goal is met; one receipt is final |
| Transaction memos (Memo contract, mainnet and testnet `0x5294…e505`) | `resolve` and `refund` are sent through the Memo contract with a readable note ("Wildsentia challenge #42: survived 3 days"), shown on the explorer and good for sharing |
| Arc runtime rules | 6-decimal ERC-20 interface vs 18-decimal native; 20 Gwei minimum `maxFeePerGas`; sends to `address(0)` revert; transfers to or from a blocklisted address revert and still cost gas |

Players never send a transaction, so no paymaster is needed.

**Next version, once the first works on testnet**

| Feature | Use |
|---|---|
| App Kit Bridge (CCTP) and Unified Balance | A creator funds a prize with USDC held on Base, Ethereum, Solana or elsewhere |
| App Kit Onramp | A creator with no crypto buys USDC on Arc by card inside the create flow |
| App Kit custom fees | Wildsentia's income: a small fee on bridge, swap or on-ramp done through our page, while players still pay nothing |
| ERC-8004 (IdentityRegistry, ReputationRegistry, ValidationRegistry; on mainnet) | AI agents get an on-chain identity, and every win is recorded as reputation and validation |
| UMA Optimistic Oracle (Arc's prediction-market sample uses it) | Results become disputable: the server proposes the winner and the log hash, and anyone can dispute with a bond during a window. This removes the server as the final judge |
| Wallet screening (Elliptic, TRM Labs) | Screen creators and winners before mainnet payouts |

**Not used**

| Feature | Why not |
|---|---|
| Earn, Borrow, Swap, StableFX, USYC | Escrowed prizes must stay exactly as locked; nothing to swap |
| Prediction markets for spectators | That is betting |
| Gateway nanopayments, x402 | Nobody pays per call; playing is free |
| ERC-8183 AgenticCommerce | Needs the provider before funding; testnet address only (section 5) |
| Opt-in privacy (APS) | Results are meant to be public |
| On-chain randomness | Arc has none suitable for money; animals are assigned off chain |

## 10. Out of scope for the first version

Automatic video clips, mainnet, teams, "raise a young", sandboxed replays, and the
"next version" features above.

## 11. Testing

- **Contract (forge):**
  - Unit tests for every function and revert.
  - A fuzz/invariant suite for the balance and pay-once invariants.
  - Tests that refund works while paused and after an evaluator change.
- **Server (vitest, against the isolated `_test` database):**
  - Goal checkers.
  - The attempt lifecycle, including restart and void.
  - First-to-finish ordering.
  - Durable chain operations with an injected chain client that fails mid-send.
  - Limits and self-dealing blocks.
  - OAuth state/PKCE handling.
- **Local end to end:** the e2e stack plus `arc-anvil` with a test USDC that implements EIP-3009
  (labelled as a local stand-in). A browser journey creates a challenge, a second account plays
  and meets a `hunt` goal, and the prize arrives; another lets a deadline pass and refunds.
- **Testnet:** the same two journeys once on Arc Testnet with faucet USDC, with the transaction
  links recorded.

## 12. Must be verified before or during the build

| Item | How |
|---|---|
| Arc USDC supports `receiveWithAuthorization` (docs confirm only `transferWithAuthorization`) | Read the token on testnet; if it is missing, fall back to approve + `createFor` |
| X OAuth 2.0 sign-in works on the X API access tier the owner has, and returns account creation date | Create the X app; test sign-in locally |
| Arc Foundry installs and deploys to testnet | Follow `docs.arc.io` install guide |
| The Memo contract's call interface (how it forwards a call and its note) | Read `docs.arc.io/arc/concepts/transaction-memos` and call it once on testnet |
| Legal status of creator-funded prizes for players in each country, and for the operator | Lawyer, before any mainnet use |
