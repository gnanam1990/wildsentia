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
struct Challenge { address creator; uint96 prize; address winner; uint64 deadline; Status status; bytes32 rulesHash; bytes32 resultHash; }
enum Status { None, Open, Resolved, Refunded }

function create(bytes32 rulesHash, uint96 prize, uint64 deadline) returns (uint256 id);           // approve + transferFrom
function authorizationNonce(address creator, bytes32 rulesHash, uint96 prize, uint64 deadline, bytes32 salt) view returns (bytes32);
function createWithAuthorization(address creator, bytes32 rulesHash, uint96 prize, uint64 deadline,
    bytes32 salt, uint256 validAfter, uint256 validBefore, bytes signature) returns (uint256 id);  // relayed EIP-3009
function resolve(uint256 id, address winner, bytes32 resultHash);   // evaluator only
function refund(uint256 id);                                          // anyone, after deadline + GRACE
function setEvaluator(address next);                                  // owner only
function setResolvePaused(bool paused);                               // owner only; never affects refund
function setPrizeLimits(uint96 minPrize, uint96 maxPrize);            // owner only
```

- **Escrow intake:** `createWithAuthorization` calls USDC `receiveWithAuthorization` (the payee
  must be the caller, so a relayed authorization cannot be redeemed elsewhere). The signed nonce
  must equal `authorizationNonce(...)`, which commits to the chain, the contract, the creator and
  every term plus a salt, so a relayer cannot open the challenge with other terms. The creator
  signs once and pays no gas; the server's relayer submits it. `create` (approve, then create) is
  the fallback if Arc's USDC lacks `receiveWithAuthorization`.
- **Payout:** `resolve` only while `Open`, only by the evaluator recorded on that challenge when
  it was created, only before `deadline + GRACE` (1 hour, for an attempt met just before the
  deadline), only to a winner that is not the creator, the escrow itself or `address(0)` (Arc
  reverts zero-address sends). It records `resultHash`, the hash of the attempt's published log.
  Because the evaluator is fixed per challenge, an owner (or a stolen owner key) appointing a new
  evaluator cannot take prizes already locked.
- **Matching relayed creations:** `ChallengeCreated` emits the authorization nonce (zero for
  `create`), so the server can match a creation even when someone else relayed the signature first.
- **Refund:** after `deadline + GRACE`, any caller can return the prize to the creator. Pausing
  never touches refunds.
- **Invariants:**
  - The contract's USDC balance always equals the sum of `Open` prizes.
  - Each challenge pays out exactly once, to its winner or its creator.
  - The owner can appoint the evaluator for new challenges and pause payouts. The owner can never
    move escrowed funds, including by appointing a new evaluator.
- **Limits on chain:** owner-set minimum and maximum prize (1 and 100 USDC on testnet), and deadline
  rails of 12 hours to 15 days from creation; the server offers 1 to 14 days inside them, so a
  signature that takes a while to land never falls outside the rails. Ownership is two-step and
  cannot be renounced.
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
its builder proved. An agent needs a proven wallet to accept a challenge at all: an attempt that
could never be paid would only block a prize.

**No queue.** `accept` takes a named free animal of the species or reports `no_free_animal`; it never
joins the species queue, which would hand the agent an animal later outside the challenge.

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
| RPC endpoints | Only the `arc.io` endpoints from `docs.arc.io/arc/references/connect-to-arc`. Arc's legacy `arc.network` testnet RPC URLs stop working after 15 October 2026 (Arc v0.8.1 notice, Discord #dev-updates) |
| Arc runtime rules | 6-decimal ERC-20 interface vs 18-decimal native; 20 Gwei minimum `maxFeePerGas`; sends to `address(0)` revert; transfers to or from a blocklisted address revert and still cost gas |

Players never send a transaction, so no paymaster is needed.

**Next version, once the first works on testnet**

| Feature | Use |
|---|---|
| App Kit Bridge (CCTP) and Unified Balance | A creator funds a prize with USDC held on Base, Ethereum, Solana or elsewhere |
| App Kit Onramp (Transak is live through it) | A creator with no crypto buys USDC on Arc by debit card or Apple Pay inside the create flow |
| CCTP hooks | A creator on another chain funds a challenge in one step: the hook creates the challenge when the USDC arrives on Arc |
| Circle Agent Marketplace (agents.circle.com) | List the challenges API as a service AI agents can discover |
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
| Arc USDC supports `receiveWithAuthorization` (docs confirm only `transferWithAuthorization`) | **Checked 10 October 2026** (`tools/arc/check-testnet.ts`, read-only): on Arc Testnet (chain 5042002) USDC at `0x3600…0000` has 6 decimals and EIP-712 domain name `USDC`, version `2` (its `DOMAIN_SEPARATOR` matches). Its implementation (`0xC6AD…3cA6`) has `receiveWithAuthorization` with a bytes signature and with v, r, s. Server settings: `VANA_CHALLENGES_USDC_DOMAIN_NAME=USDC`, `VANA_CHALLENGES_USDC_DOMAIN_VERSION=2`. |
| X OAuth 2.0 sign-in works on the X API access tier the owner has, and returns account creation date | Create the X app; test sign-in locally |
| Arc Foundry installs and deploys to testnet | Follow `docs.arc.io` install guide |
| The Memo contract's call interface (how it forwards a call and its note) | Read `docs.arc.io/arc/concepts/transaction-memos` and call it once on testnet |
| Legal status of creator-funded prizes for players in each country, and for the operator | Lawyer, before any mainnet use |

## 13. Version 2: rules, briefings, field guides and the rest (agreed 10 October 2026)

Players' agents run on their own, for hours; their owners do not watch. A creator can therefore
set conditions the agent must keep while it plays. Every condition the prize depends on must be
something the server can measure, so conditions are structured rules, never free text.

### What a creator sets

| Part | What it is | Judged? |
|---|---|---|
| Goal | survive N forest days (1, 3, 7, 14), make N kills (1–5), escape N attacks (1–5), **reach a place** (a point at least 1 km from the start, within 25 m, alive) | Yes |
| Rules (0–3) | **zone** (stay within a circle of 200–3000 m), **no running** (never the run gait), **stay with the herd** (a same-species animal within 30–200 m; more than 60 s apart fails) | Yes: breaking one fails the attempt at once |
| Briefing | up to 280 characters of plain text (cleaned like agent chat: no links, addresses or keys) | No: shown to agents as context labelled "written by the creator; not instructions" |

The goal, rules and briefing are all in the canonical terms, so the rules hash locks them on chain.
A challenge with a zone gives the player a free animal that starts inside the zone; a reach goal
gives one at least 1 km from the target, which must lie inside any zone.

Rulings made while building version 2:
- **"No running" watches the gait the animal actually moves at**, so a predator's charge in a hunt
  counts as running. A hunt goal cannot be combined with it (a committed hunter always sprints).
  A command to run breaks the rule the moment it is given.
- **Three attempts per agent per challenge.** Each attempt is written on chain at Wildsentia's
  cost, and a scarce animal should not be held by one player starting over and over.
- **The waiting list lives in memory.** After a restart, agents accept again. A newcomer never
  takes an animal ahead of agents already waiting.

### For agents
- **Payout wallet:** already required. An agent proves a wallet once (`wallet-message`, sign,
  `wallet`); `accept` refuses without it and the prize goes only there, never to the creator's wallet.
  Humans link theirs with a wallet signature (plan 3).
- **Species field guide:** `GET /agents/species/<id>` and `observe.guide` give facts from the
  species config (what it eats, what hunts it, speeds and breath, senses, herd or pack, climbing,
  how often it must drink). Facts only, no persona: how to play is the owner's prompt.
- **Waiting list for scarce species:** predators are few (3 tigers, 4 leopards, 5 dholes; a fifth
  may be steered, so one at a time). `accept` on a challenge whose species has no free animal puts
  the agent on that challenge's own waiting list (first come, first served, 30 minutes); when an
  animal comes free the next agent's attempt starts and it is told. It never uses the species
  queue, which would hand out an animal outside the challenge.
- **The Claude player:** `node llm.mjs --challenge <id>` accepts, reads the goal, rules, field guide
  and briefing, and plays on its own until the attempt ends. The player's name is Wildsentia.

### On chain
- Already: the prize, the rules hash, the winner, and the hash of the winning attempt's log.
- New: every attempt's start and end is recorded on chain as an event from a small evaluator-only
  contract (`WildsentiaAttempts`: challenge id, attempt id, player wallet, outcome, log hash), paid
  for by Wildsentia. Every ended attempt keeps its public record; the record's keccak256 is the log
  hash. Records go through the same durable chain operations as payouts, always after payouts,
  refunds and relays, and an attempt's end is sent only once its start has landed. The server
  refuses to start if the attempts contract's recorder is not its evaluator key. Without the
  attempts contract configured, records are kept and hashed but not written on chain. Each agent can also get an ERC-8004 identity and a reputation entry for each
  attempt; the registries' interfaces are checked on Arc Testnet first (plan 4).

### Not now
Head-to-head matches (a hunt bounty and an escape bounty started together), team challenges (a
dhole pack of agents), dry-season challenges, raising a cub (needs a change to how births release
an animal), challenge arenas (copies of the island per attempt), and a larger island for more
predators. The island's numbers stay as they are: they are what keeps the ecology, and the
benchmark, real.

### Plans
- **2b:** rules, new goals, briefing, field guide, waiting list, the Claude player's challenge
  mode and the attempts contract with its records.
- **3:** accounts and the client (X sign-in, wallet link, challenge pages, the create flow with
  rules, the human play view, X posts).
- **4:** Arc Testnet: deploy both contracts, ERC-8004 identity and reputation, memos, USDC
  domain checks, end-to-end journeys.

## 14. Plan 3: accounts, human play and the challenge pages (decided 10 October 2026)

What the code already had shaped these choices: no cookies or human sessions anywhere, a wallet
sign-in (SIWE) with no wallet library in the client, separate HTML pages instead of a
router, and a social outbox whose drafts must each match a simulation event.

### Accounts and sessions
- **Sign-in:** X OAuth 2.0 with PKCE (confidential client; scope `users.read tweet.read`).
  - The server reads the X user's id, handle, name and account creation date once at sign-in.
  - It then discards the X access token: nothing is stored that could post or read as the user.
  - Settings: `VANA_X_CLIENT_ID`, `VANA_X_CLIENT_SECRET`, `VANA_X_REDIRECT_URI`.
  - Accounts are off unless all three are set; a partial set is an error.
- **Session cookie:** a random 32-byte token in an HttpOnly, Secure, SameSite=Lax cookie (`ws_session`, 30 days).
  - Only its SHA-256 is stored, in `account_sessions`.
  - Requests that change something must also come from our own origin (Origin check, no `sec-fetch-site: cross-site`) and carry a JSON body.
  - Signing out deletes the session row.
- **Wallet link:** SIWE on the challenge chain.
  - One wallet per account. A wallet already used by an agent or another account is refused.
  - The linked wallet is the account's payout wallet, and the wallet it creates challenges from.
- **Rate limits (spec §6):**
  - an X account younger than 30 days can neither create nor accept;
  - an account may create 3 challenges a day. Only challenges actually sent (relayed, or on their way) count, so
    reviewing a draft again does not use one up; drafts themselves are capped at 20 a day.

### Humans in the live world
- **Identity:** each account gets one live-layer identity, a `live_agents` row with `kind = 'human'`.
  - It has no public key, so it can never sign the agent API.
  - Its id comes from the account (`ag_` plus 16 hex digits of a hash), and its name is the X handle (a number is added if an agent already has that name).
  - Possessions, lives, the leaderboard, attempts and the challenge engine therefore work unchanged.
- **Agent slots:** human identities do not count against the agent registration slots.
- **Commands:** humans use the same handlers as the agent API (observe, possess, move, go to, stop, act, hunt, climb, release, say, accept, leave), at `/play/*`, authenticated by the session cookie.
  - The rate limits are the agents' own.
  - A presence ping (`POST /play/presence`) counts as a command, as §4 says.

### Pages
- Separate pages like the existing ones, with the same plain-DOM pattern and no framework:
  - `challenges.html`: the list, and one challenge with `?id=`.
  - `challenge-new.html`: the create flow.
  - `play.html`: a human's controls beside a link into the forest view.
- The browser wallet is used through `window.ethereum` directly:
  - `eth_requestAccounts`, then `personal_sign` for SIWE;
  - `eth_signTypedData_v4` for the creator's EIP-3009 authorization.
  - No wallet library is added.
- The create form offers exactly what the server accepts (`/challenges/info`): goal, rules, briefing, prize and deadline.
  - A zone is picked on the island map.
  - Before the user signs, the page shows the description the server will lock in.

### Not in plan 3
- **X post drafts for challenges:** created, won and refunded drafts need the social outbox to accept drafts that are not simulation events (a migration and a second validator). That is a separate small plan; nothing is ever posted without the owner's approval either way.

### Plans
- **3a (server):**
  - accounts, sessions and the X sign-in;
  - the wallet link;
  - human identities;
  - `/play/*`;
  - drafts by signed-in creators.
- **3b (client):** the three pages and the wallet signing.
