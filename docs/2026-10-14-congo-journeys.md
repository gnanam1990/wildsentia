# Congo Phase 1: browser journeys (14 October 2026)

**Setup:** the local demo server (`tools/dev/congoDemo.ts`, `VANA_DEV_DEMO=1`, a local database), the Vite client, and the desktop app's browser pane.
- **Test people:** Amara and Kofi, with test wallets.
- **The agent:** the example agent (`agent-client/examples/congo-hunter.mjs`) runs over the MCP bridge (`agent-client/mcp.mjs`).
- **Money:** every amount is SIMULATED.

## A person's journey

1. **Amara buys and spawns.** She signs in, buys a blue duiker (5.00 SIM-USDC) and spawns it. It lives wild: [screenshot](2026-10-13-congo-screens/journeys/1-owner-spawned.jpg).
2. **Amara steers it.** On the play page she is "a blue duiker". Her steering survived a server restart, restored by its lease: [screenshot](2026-10-13-congo-screens/journeys/2-owner-steers.jpg).
3. **Kofi authorises an agent.** He buys an African leopard (50.00 SIM-USDC), spawns it, and authorises the example agent by its id: [screenshot](2026-10-13-congo-screens/journeys/3-owner-authorises-agent.jpg).
4. **The operator publishes a bounty.**
   - It is a Standard bounty on Amara's duiker: 10.00 SIM-USDC, 3 world days.
   - All six checks pass: alive, funded, navigable, water, food and predator.
   - Publishing reserves the reward: [screenshot](2026-10-13-congo-screens/journeys/4-admin-published.jpg).
6. **Each owner sees their side.**
   - Kofi's leopard: "Payout recorded (SIMULATED)": [screenshot](2026-10-13-congo-screens/journeys/5-predator-owner-paid.jpg).
   - Amara, at phone width (375 px, no horizontal scroll): "Cooldown, can respawn in 1 h 57 min, taken by a predator: the reward went to its owner": [screenshot](2026-10-13-congo-screens/journeys/6-target-owner-phone.jpg).

## The agent's journey

5. **The example agent hunts over MCP.**
   - It takes Kofi's leopard and reads the bounty board.
   - It **sees** the duiker 60 m away and learns it carries the bounty: discovery by perception.
   - It closes to 39.6 m, 19.2 m, then 0 m, and hunts.
   - **The outcome:** the bounty settles with outcome `predator`. The payout of 10 SIM-USDC is recorded to Kofi's test wallet, and the record has its rules hash and event slice.
   - **One shortcut:** a demo-only endpoint set the leopard down 60 m from the duiker, so the journey did not wait for the agent to range across 48 km. Ranging itself is the agent's spiral loop.
   - **The same hunt runs unstaged in a test:** the end-to-end test `exampleAgent.test.ts` runs it against a real HTTP server. There the leopard smelled the target at 60 m, saw it at 20 m and caught it.

## What the journeys found (each fixed with a test)

- **Sign-in:** the play page needs `/accounts/me`. The demo now serves it for its test people.
- **Payout shown to the wrong owner:** a predator's payout was shown as "Payout recorded" on the target's page. Each owner now sees the bounty from their side (`paidToOwner`, `role`).
- **Premature Respawn button:** the outcome label hid a running cooldown and offered a Respawn button that could not work. The cooldown now leads.
- **Fractional time left:** the public time left showed fractions of a second. It is now rounded.
