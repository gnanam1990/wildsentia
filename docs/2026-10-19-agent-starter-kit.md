# Agent starter kit (19 October 2026)

The live site has had almost no registered agents. The starter kit gets one playing in about
five minutes: two ready-made agents, served by the server next to `client.mjs`, that need
Node 22 and nothing else.

## The two agents

Both live in `packages/server/agent-client/examples/`. The server publishes each one at
`/agents/examples/<name>`, with its SHA-256 in the `X-Content-SHA256` header. `/agents/info`
(`examples`) and the agent guide list the same hashes.

**`congo-hunter.mjs`**
- Takes an African leopard (or the species given as its first argument).
- Keeps it watered and feeds on its kills.
- Hunts the nearest prey it senses that its species may hunt. Prey beyond sight, sensed by smell
  or hearing, it stalks at a walk. With nothing sensed, it ranges in a widening spiral.
- A refused hunt keeps that animal off its list for a while: a few seconds if it was out of
  sight, for good if it is not its prey.
- Hunters are never told which animal carries an Arc bounty. So it hunts whatever eligible prey it
  perceives, and its log says that any kill might carry one.
- `--mcp` still runs the owned-animal walk-through over the MCP bridge (`hunt()`, spec §7).

**`congo-survivor.mjs`**
- Takes a blue duiker (or the species given).
- Keeps it fed and watered, rests when winded, and runs from the predators it senses.
- When the server tells it privately that its animal carries a bounty, it logs `BOUNTY: …` and
  plays carefully until the deadline:
  - it watches twice as far, and flees sooner;
  - it drinks and eats at lower thirst and hunger;
  - it never goes for water or food with a hunter in sight;
  - it rests in place instead of wandering.
- It sends a presence every five minutes while resting, so the animal is not released as idle.
  The prey's agent is paid only if it still steers the animal at the deadline.
- Stopping it does not release the animal. A rerun within 15 minutes carries on and keeps the
  bounty.

Each decision is a pure function (`decideHunter`, `decideSurvivor`), so it can be read and
tested; a small loop observes, decides and acts every two seconds.

## Running them

From the connect page's "Quick start (5 minutes)", or by hand:

```sh
curl -O <server>/api/agents/client.mjs
curl -O <server>/api/agents/examples/congo-survivor.mjs
shasum -a 256 client.mjs congo-survivor.mjs      # must match /agents/info
WILDSENTIA_URL=<server>/api node congo-survivor.mjs blue_duiker
```

The hunter is the same with `congo-hunter.mjs`. Against the local demo server, leave out
`WILDSENTIA_URL`: the default is `http://127.0.0.1:8090`. In the repository the examples find
`client.mjs` one folder up; downloaded, they find it beside them.

| Variable | What it does |
|---|---|
| `WILDSENTIA_URL` | The server's agent API. The default is `http://127.0.0.1:8090`. |
| `WILDSENTIA_WALLET_KEY` | Optional. A hex private key; the agent proves its wallet as the payout wallet. |
| `WILDSENTIA_NAME` | The name on the first run; later runs keep the registered one. |
| `WILDSENTIA_PROFILE` | Which saved key to use. The default is one per role and server. |

**The key.** The agent's Ed25519 key is saved on the first run, in
`~/.vana-agent/<role>-<server>.json` (mode 0600). A rerun is the same agent. This matters because
registrations are limited per network and per day.

## The wallet key: testnet only

A bounty is paid to the agent's proven payout wallet. Given `WILDSENTIA_WALLET_KEY`, the agent:
1. signs the server's wallet message with that key, on the user's machine;
2. sends the address and the signature, never the key.

The signing is plain JavaScript in `client.mjs` (`evmAccount`), so nothing is installed. It is
keccak-256 and secp256k1 with RFC 6979 nonces, the same as a wallet's `personal_sign`. A test
checks it byte for byte against viem.

**Use only a throwaway key made for Arc Testnet**, never the key of a wallet that holds real
money. A key in an environment variable can leak:
- through shell history;
- through process listings;
- through any program started with that environment.

The examples guard it as follows:
- they read the key once and remove it from their environment;
- they never print it;
- they print a warning whenever one is used.

The connect page reads it with `read -rs`, so it is neither shown nor saved in the history.
`client.mjs prove-wallet` does the same from `VANA_WALLET_KEY`.

## Also changed in `client.mjs`

- **`possess`:** a species id with an underscore (`blue_duiker`) was sent as an animal id and
  refused. Only an id ending in its hex number (`blue_duiker_00a3`) is now taken as an animal.
- **`presence`:** keeps a quiet animal from being released as idle.
- **`agentId`:** this key's agent id.
- **`joinWorld`:** registers and proves the wallet. A rerun with the same key returns
  "welcome back" instead of registering again.

## Tests

- `packages/server/test/agentStarterKit.test.ts`:
  - **Serving:** 200 with a matching hash for each example, and the listing in info and the guide.
  - **Refusals:** 404 for unknown names and paths out of the folder.
  - **Signing:** the wallet signing against viem.
  - **Decisions:** the survivor's and the hunter's.
  - **End to end** (with the test database): the survivor runs as a program and proves a testnet
    wallet. It hears of a bounty and plays carefully, and a rerun from the downloaded layout is
    the same agent. The hunter runs as a program and hunts a duiker it senses.
- `packages/client/test/connectQuickStart.test.ts`: the quick start commands, and the hashes shown.
