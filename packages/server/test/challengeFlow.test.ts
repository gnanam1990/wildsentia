import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { landWalkable, patchCentre } from '@vana/shared';
import { createWorld } from '@vana/sim';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { viemChallengeChain } from '../src/challenges/chain.js';
import { ChainOps } from '../src/challenges/chainOps.js';
import { createDraft, draftTypedData, relayDraft, type DraftConfig } from '../src/challenges/drafts.js';
import { ChallengeEngine } from '../src/challenges/engine.js';
import { ChallengeIndexer } from '../src/challenges/indexer.js';
import { ChallengeStore } from '../src/challenges/store.js';
import type { SpeciesCatalog } from '../src/challenges/terms.js';
import { ANVIL_KEYS, CHAIN_ID, anvilAvailable, startLocalChain, usdcBalance, type LocalChain } from './anvil.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url && anvilAvailable() ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

maybe('a challenge from draft to paid winner (local anvil, LOCAL TEST STAND-IN USDC)', () => {
  let local: LocalChain;
  beforeAll(async () => {
    local = await startLocalChain();
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor, live_agents cascade');
    await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash) values ('ag_00000000000000f1', $1, 'Stripe', 'stripe', 'n')`,
      ['f1'.padEnd(43, 'A')]);
  });
  afterAll(async () => { local?.stop(); await pool?.end(); });

  it('drafts, relays, indexes, plays and pays, with the result hash on chain', async () => {
    const store = new ChallengeStore(pool!);
    const chain = viemChallengeChain({ rpcUrl: local.url, chainId: CHAIN_ID, contract: local.contract, evaluatorKey: ANVIL_KEYS.evaluator });
    const config: DraftConfig = { chainId: CHAIN_ID, contract: local.contract, usdc: local.usdc, usdcDomain: { name: 'USDC', version: '2' },
      minPrizeAtomic: 1_000_000n, maxPrizeAtomic: 100_000_000n };
    const world = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1', initialAgents: { tiger: 2, chital: 12 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w');
    const catalog: SpeciesCatalog = { ids: () => [...world.species.keys()], preyOf: (id) => port.species(id)?.preferredPrey ?? [],
      displayName: (id) => port.species(id)?.displayName ?? id };

    // 1. The creator's draft: its nonce is exactly the contract's.
    const made = await createDraft(store, catalog, config, { creatorWallet: local.addresses.creator, terms: { template: 'hunt', speciesId: 'tiger' },
      prizeUsdc: '10', days: 3 }, Date.now());
    if (!made.ok) throw new Error(made.error);
    expect(made.description).toBe('Make a kill as a tiger');
    const reader = createPublicClient({ cacheTime: 0, transport: http(local.url) });
    const onChainNonce = await reader.readContract({ address: local.contract,
      abi: parseAbi(['function authorizationNonce(address,bytes32,uint96,uint64,bytes32) view returns (bytes32)']), functionName: 'authorizationNonce',
      args: [local.addresses.creator, made.draft.rulesHash, 10_000_000n, BigInt(made.draft.deadline.getTime() / 1000), made.draft.salt] });
    expect(made.draft.authNonce).toBe(onChainNonce);

    // 2. A wrong signature is refused before any gas is spent; the creator's own is relayed.
    const wrong = await privateKeyToAccount(ANVIL_KEYS.player).signTypedData(draftTypedData(config, made.draft));
    expect(await relayDraft(store, config, made.draft.id, wrong, Date.now())).toMatchObject({ ok: false, error: 'signature_does_not_match' });
    const signature = await privateKeyToAccount(ANVIL_KEYS.creator).signTypedData(draftTypedData(config, made.draft));
    expect(await relayDraft(store, config, made.draft.id, signature, Date.now())).toEqual({ ok: true });
    const ops = new ChainOps(store, chain);
    // Chain operations run on a timer in the server; here, until the operation settles.
    const settle = async (status: () => Promise<string | undefined>, want: string) => {
      for (let i = 0; i < 100 && (await status()) !== want; i++) { await ops.processOnce(); await new Promise((r) => setTimeout(r, 30)); }
    };
    await settle(async () => (await store.opsOf({ draftId: made.draft.id }))[0]?.status, 'confirmed');
    expect((await store.opsOf({ draftId: made.draft.id }))[0]!.status).toBe('confirmed');
    expect(await usdcBalance(local, local.contract)).toBe(10_000_000n);

    // 3. The indexer recognises it as ours.
    expect(await new ChallengeIndexer(store, chain, 0).pollOnce()).toBe(1);
    const challenge = (await store.challenge(1))!;
    expect(challenge).toMatchObject({ status: 'open', draftId: made.draft.id, terms: { template: 'hunt', speciesId: 'tiger' } });

    // 4. An agent's tiger makes a kill.
    let now = 1_000_000;
    const live = new LiveLayer(port, null, () => now, () => 0);
    const engine = new ChallengeEngine(store, live, port);
    live.onHunt = (h) => engine.onHunt(h); live.onCommand = (c) => engine.onCommand(c); live.onEnded = (l) => engine.onEnded(l);
    const accepted = await engine.accept({ agentId: 'ag_00000000000000f1', name: 'Stripe', wallet: local.addresses.player.toLowerCase(),
      walletProven: true }, 1);
    if (!accepted.ok) throw new Error(accepted.error);
    const open = world.patches.find((p) => landWalkable(p) && p.neighbours.every((n) => landWalkable(world.patches[n])))!;
    const c = patchCentre(open.id);
    const tiger = world.animal(accepted.animalId)!, prey = world.agents.find((a) => a.alive && a.speciesId === 'chital' && a.lifeStage === 'adult')!;
    tiger.patchId = open.id; tiger.position = { x: c.x, z: c.z, heading: 0 };
    const avatar = live.avatars.get('ag_00000000000000f1')!; avatar.x = c.x; avatar.z = c.z;
    prey.patchId = open.id; prey.position = { x: c.x + 30, z: c.z, heading: 0 };
    live.hunt('ag_00000000000000f1', prey.id);
    for (let i = 0; i < 600; i++) { now += 100; live.tick(0.1); }
    await engine.tick();
    const attempt = (await store.attempt(accepted.attemptId))!;
    expect(attempt.status).toBe('met');

    // 5. The payout is sent, confirmed, and the contract holds the attempt's result hash.
    await settle(async () => (await store.challenge(1))?.status, 'paid');
    expect((await store.challenge(1))!.status).toBe('paid');
    expect(await usdcBalance(local, local.addresses.player)).toBe(10_000_000n);
    const onChain = await reader.readContract({ address: local.contract, abi: parseAbi([
      'struct Challenge { address creator; uint96 prize; address winner; uint64 deadline; uint8 status; bytes32 rulesHash; bytes32 resultHash; address evaluator; }',
      'function challenge(uint256) view returns (Challenge)']), functionName: 'challenge', args: [1n] });
    expect(onChain.resultHash).toBe(attempt.resultHash as Hex);
    expect(onChain.winner.toLowerCase()).toBe(local.addresses.player.toLowerCase());
  });
});
