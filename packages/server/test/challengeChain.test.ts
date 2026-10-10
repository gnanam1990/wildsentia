import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ARC_MIN_FEE_PER_GAS, attemptKey, viemChallengeChain, type ChallengeChain } from '../src/challenges/chain.js';
import { ANVIL_KEYS, CHAIN_ID, anvilAvailable, signReceive, startLocalChain, usdcBalance, type LocalChain } from './anvil.js';

const maybe = anvilAvailable() ? describe : describe.skip;
const RULES = `0x${'1'.repeat(64)}` as Hex;
const erc20 = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);
const createAbi = parseAbi(['function create(bytes32 rulesHash, uint96 prize, uint64 deadline) returns (uint256)']);

maybe('challenge chain client (local anvil)', () => {
  let local: LocalChain, chain: ChallengeChain;
  beforeAll(async () => {
    local = await startLocalChain();
    chain = viemChallengeChain({ rpcUrl: local.url, chainId: CHAIN_ID, contract: local.contract, evaluatorKey: ANVIL_KEYS.evaluator,
      attemptsContract: local.attempts, identityRegistry: local.identity, reputationRegistry: local.reputation });
  });
  afterAll(() => local?.stop());

  const now = async () => Number((await createPublicClient({ transport: http(local.url) }).getBlock()).timestamp);
  const send = async (call: Parameters<ChallengeChain['prepare']>[0]) => {
    const tx = await chain.prepare(call);
    await chain.broadcast(tx.raw);
    for (let i = 0; i < 50; i++) { const r = await chain.receipt(tx.hash); if (r) return { ...tx, outcome: r }; await new Promise((s) => setTimeout(s, 50)); }
    throw new Error('not mined');
  };

  it('reads a challenge created with an allowance, and pays its winner', async () => {
    const creator = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS.creator), transport: http(local.url), chain: null });
    const reader = createPublicClient({ transport: http(local.url) });
    await reader.waitForTransactionReceipt({ hash: await creator.writeContract({ address: local.usdc, abi: erc20, functionName: 'approve',
      args: [local.contract, 10_000_000n], chain: null }) });
    const deadline = BigInt(await now() + 2 * 86_400);
    const created = await reader.waitForTransactionReceipt({ hash: await creator.writeContract({ address: local.contract, abi: createAbi,
      functionName: 'create', args: [RULES, 10_000_000n, deadline], chain: null }) });
    expect(created.status).toBe('success');
    const events = await chain.createdEvents(0, await chain.head());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 1, creator: local.addresses.creator.toLowerCase(), prizeAtomic: '10000000', deadline: Number(deadline),
      rulesHash: RULES, authNonce: `0x${'0'.repeat(64)}` });
    expect(await chain.status(1)).toMatchObject({ status: 'open', evaluator: local.addresses.evaluator });
    expect(await chain.appointedEvaluator()).toBe(local.addresses.evaluator);
    expect(await chain.prizeLimits()).toEqual({ min: 1_000_000n, max: 100_000_000n });

    const paid = await send({ fn: 'resolve', id: 1, winner: local.addresses.player, resultHash: `0x${'e'.repeat(64)}` });
    expect(paid.outcome).toBe('success');
    expect(await chain.known(paid.hash)).toBe(true);
    expect(await usdcBalance(local, local.addresses.player)).toBe(10_000_000n);
    expect((await chain.status(1)).status).toBe('resolved');
  });

  it('signs at no less than Arc’s fee floor and can broadcast the same transaction twice', async () => {
    const deadline = BigInt(await now() + 2 * 86_400);
    const salt = `0x${'5'.repeat(64)}` as Hex;
    const nonce = await createPublicClient({ transport: http(local.url) }).readContract({ address: local.contract,
      abi: parseAbi(['function authorizationNonce(address,bytes32,uint96,uint64,bytes32) view returns (bytes32)']),
      functionName: 'authorizationNonce', args: [local.addresses.creator, RULES, 5_000_000n, deadline, salt] });
    const validBefore = BigInt(await now() + 3600);
    const signature = await signReceive(local, { value: 5_000_000n, validAfter: 0n, validBefore, nonce });
    const tx = await chain.prepare({ fn: 'createWithAuthorization', creator: local.addresses.creator, rulesHash: RULES, prize: 5_000_000n,
      deadline, salt, validAfter: 0n, validBefore, signature });
    const parsed = await createPublicClient({ transport: http(local.url) }).request({ method: 'eth_sendRawTransaction', params: [tx.raw] });
    expect(parsed).toBe(tx.hash);
    await chain.broadcast(tx.raw); // already known: not an error
    let receipt = null;
    for (let i = 0; i < 50 && !receipt; i++) { receipt = await chain.receipt(tx.hash); await new Promise((s) => setTimeout(s, 50)); }
    expect(receipt).toBe('success');
    const fee = await createPublicClient({ transport: http(local.url) }).getTransaction({ hash: tx.hash });
    expect(fee.maxFeePerGas! >= ARC_MIN_FEE_PER_GAS).toBe(true);
    const events = await chain.createdEvents(0, await chain.head());
    expect(events.at(-1)).toMatchObject({ id: 2, authNonce: nonce, prizeAtomic: '5000000' });
  });

  it("writes an attempt's start and end to the attempts contract, keyed by its uuid", async () => {
    const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    expect(attemptKey(id)).toBe(`0x0f1e2d3c4b5a69788796a5b4c3d2e1f0${'0'.repeat(32)}`);
    expect(attemptKey(id.toUpperCase())).toBe(attemptKey(id));
    expect(chain.attempts?.toLowerCase()).toBe(local.attempts.toLowerCase());
    expect(await chain.attemptsRecorder()).toBe(local.addresses.evaluator);
    expect(await chain.attemptStage(id)).toBe(0);
    expect((await send({ fn: 'recordStart', attemptId: id, challengeId: 1, player: local.addresses.player })).outcome).toBe('success');
    expect(await chain.attemptStage(id)).toBe(1);
    expect((await send({ fn: 'recordEnd', attemptId: id, challengeId: 1, outcome: 2, logHash: `0x${'7'.repeat(64)}` })).outcome).toBe('success');
    expect(await chain.attemptStage(id)).toBe(2);
    const logs = await createPublicClient({ transport: http(local.url) }).getLogs({ address: local.attempts, fromBlock: 0n,
      event: parseAbi(['event AttemptEnded(bytes32 indexed attemptId, uint256 indexed challengeId, uint8 outcome, bytes32 logHash)'])[0] });
    expect(logs.map((l) => [l.args.attemptId, l.args.challengeId, l.args.outcome, l.args.logHash]))
      .toEqual([[attemptKey(id), 1n, 2, `0x${'7'.repeat(64)}`]]);
    await expect(chain.prepare({ fn: 'recordEnd', attemptId: id, challengeId: 1, outcome: 1, logHash: `0x${'7'.repeat(64)}` }))
      .rejects.toThrow(/AlreadyEnded|revert/i);
    // Without an attempts contract the client refuses record calls and reads nothing.
    const bare = viemChallengeChain({ rpcUrl: local.url, chainId: CHAIN_ID, contract: local.contract, evaluatorKey: ANVIL_KEYS.evaluator });
    expect(bare.attempts).toBeNull();
    expect(await bare.attemptStage(id)).toBe(0);
    await expect(bare.prepare({ fn: 'recordStart', attemptId: id, challengeId: 1, player: local.addresses.player })).rejects.toThrow(/not configured/);
  });

  it('reads who owns an ERC-8004 identity and gives feedback on it as the evaluator', async () => {
    const player = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS.player), transport: http(local.url), chain: null });
    const reader = createPublicClient({ transport: http(local.url) });
    await reader.waitForTransactionReceipt({ hash: await player.writeContract({ address: local.identity, chain: null,
      abi: parseAbi(['function register(string)']), functionName: 'register', args: ['https://example.test/agent.json'] }) });
    expect(await chain.identityOwner(1n)).toBe(local.addresses.player);
    expect(await chain.identityOwner(99n)).toBeNull();
    const hash = `0x${'6'.repeat(64)}` as Hex;
    expect((await send({ fn: 'giveFeedback', agentId: 1n, value: 100n, tag2: 'met', endpoint: 'https://wildsentia.test/challenges.html?id=1',
      feedbackURI: 'https://wildsentia.test/api/challenges/1/attempts/a', feedbackHash: hash })).outcome).toBe('success');
    const logs = await reader.getLogs({ address: local.reputation, fromBlock: 0n, event: parseAbi(['event NewFeedback(uint256 indexed agentId, address indexed clientAddress, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)'])[0] });
    expect(logs.map((l) => [l.args.agentId, l.args.clientAddress, l.args.value, l.args.tag1, l.args.tag2, l.args.feedbackHash]))
      .toEqual([[1n, local.addresses.evaluator, 100n, 'wildsentia-challenge', 'met', hash]]);
    const bare = viemChallengeChain({ rpcUrl: local.url, chainId: CHAIN_ID, contract: local.contract, evaluatorKey: ANVIL_KEYS.evaluator });
    expect(bare.reputation).toBeNull();
    await expect(bare.identityOwner(1n)).rejects.toThrow(/not configured/);
  });

  it('cannot prepare a transaction the contract would refuse', async () => {
    await expect(chain.prepare({ fn: 'refund', id: 2 })).rejects.toThrow(/TooEarly|revert/i);
    expect(await chain.receipt(`0x${'9'.repeat(64)}`)).toBeNull();
    expect(await chain.known(`0x${'9'.repeat(64)}`)).toBe(false);
  });
});
