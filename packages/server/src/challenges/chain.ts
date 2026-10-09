import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { attemptsAbi } from './attemptsAbi.js';
import { challengesAbi } from './challengesAbi.js';
import type { CreatedEvent } from './store.js';

/**
 * The WildsentiaChallenges contract as the server sees it: reading ChallengeCreated events and
 * challenge state, and signing the evaluator's transactions. Signing and broadcasting are
 * separate so the transaction hash is stored before anything is sent (chainOps.ts).
 */

/** Arc's mempool refuses a maxFeePerGas below 20 Gwei (docs.arc.io, EVM differences). */
export const ARC_MIN_FEE_PER_GAS = 20_000_000_000n;
export const PRIORITY_FEE_PER_GAS = 1_000_000_000n;

export type ChainCall =
  | { fn: 'resolve'; id: number; winner: Hex; resultHash: Hex }
  | { fn: 'refund'; id: number }
  | { fn: 'createWithAuthorization'; creator: Hex; rulesHash: Hex; prize: bigint; deadline: bigint; salt: Hex;
      validAfter: bigint; validBefore: bigint; signature: Hex }
  | { fn: 'recordStart'; attemptId: string; challengeId: number; player: Hex }
  | { fn: 'recordEnd'; attemptId: string; challengeId: number; outcome: AttemptOutcome; logHash: Hex };

/** WildsentiaAttempts.Outcome: 1 met, 2 failed, 3 void. */
export type AttemptOutcome = 1 | 2 | 3;
/** An attempt's uuid as the bytes32 the attempts contract keys it by: its 16 bytes, then zeros. */
export const attemptKey = (attemptId: string): Hex => `0x${attemptId.replace(/-/g, '').toLowerCase()}${'0'.repeat(32)}`;

export type OnChainStatus = 'none' | 'open' | 'resolved' | 'refunded';
/** Re-signing a stuck transaction: the same nonce, and at least this fee cap. */
export interface PrepareOptions { nonce?: number; minMaxFeePerGas?: bigint }
export interface Prepared { hash: Hex; raw: Hex; nonce: number; maxFeePerGas: bigint }
const STATUS: OnChainStatus[] = ['none', 'open', 'resolved', 'refunded'];

export interface ChallengeChain {
  readonly contract: Hex;
  /** The WildsentiaAttempts contract, if attempts are recorded on chain. */
  readonly attempts: Hex | null;
  readonly evaluator: Hex;
  readonly chainId: number;
  head(): Promise<number>;
  createdEvents(fromBlock: number, toBlock: number): Promise<CreatedEvent[]>;
  status(id: number): Promise<{ status: OnChainStatus; evaluator: Hex; winner: Hex; prize: bigint }>;
  /** The evaluator the contract appoints for new challenges. */
  appointedEvaluator(): Promise<Hex>;
  /** The contract's prize limits, in 6-decimal USDC units. */
  prizeLimits(): Promise<{ min: bigint; max: bigint }>;
  /** How many challenges the contract had created as of a block. */
  challengeCount(atBlock: number): Promise<number>;
  /** An attempt's stage in the attempts contract: 0 unknown, 1 started, 2 ended. */
  attemptStage(attemptId: string): Promise<0 | 1 | 2>;
  /** The address the attempts contract lets write records. */
  attemptsRecorder(): Promise<Hex>;
  /** Signs the call with the evaluator key at the current fees; nothing is sent. */
  prepare(call: ChainCall, options?: PrepareOptions): Promise<Prepared>;
  broadcast(raw: Hex): Promise<void>;
  /** The receipt's outcome, or null while the transaction is not yet mined. */
  receipt(hash: Hex): Promise<'success' | 'reverted' | null>;
  /** True if the node knows the transaction (pending or mined). */
  known(hash: Hex): Promise<boolean>;
}

export interface ChainConfig { rpcUrl: string; chainId: number; contract: Hex; evaluatorKey: Hex; attemptsContract?: Hex | null }

export function viemChallengeChain(config: ChainConfig): ChallengeChain {
  // No cached block number: the indexer and the fee check must see the chain as it is now.
  const client = createPublicClient({ cacheTime: 0, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  const account = privateKeyToAccount(config.evaluatorKey);
  const contract = getAddress(config.contract);
  const attempts = config.attemptsContract ? getAddress(config.attemptsContract) : null;
  /** The contract a call goes to. */
  const target = (call: ChainCall): Hex => {
    if (call.fn !== 'recordStart' && call.fn !== 'recordEnd') return contract;
    if (!attempts) throw new Error('attempts contract not configured');
    return attempts;
  };
  const encode = (call: ChainCall): Hex => {
    switch (call.fn) {
      case 'recordStart': return encodeFunctionData({ abi: attemptsAbi, functionName: 'recordStart',
        args: [attemptKey(call.attemptId), BigInt(call.challengeId), call.player] });
      case 'recordEnd': return encodeFunctionData({ abi: attemptsAbi, functionName: 'recordEnd',
        args: [attemptKey(call.attemptId), BigInt(call.challengeId), call.outcome, call.logHash] });
      case 'resolve': return encodeFunctionData({ abi: challengesAbi, functionName: 'resolve', args: [BigInt(call.id), call.winner, call.resultHash] });
      case 'refund': return encodeFunctionData({ abi: challengesAbi, functionName: 'refund', args: [BigInt(call.id)] });
      case 'createWithAuthorization': return encodeFunctionData({ abi: challengesAbi, functionName: 'createWithAuthorization',
        args: [call.creator, call.rulesHash, call.prize, call.deadline, call.salt, call.validAfter, call.validBefore, call.signature] });
    }
  };
  return {
    contract, attempts, evaluator: account.address, chainId: config.chainId,
    async head() { return Number(await client.getBlockNumber()); },
    async createdEvents(fromBlock, toBlock) {
      if (toBlock < fromBlock) return [];
      const logs = await client.getLogs({ address: contract, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) });
      return parseEventLogs({ abi: challengesAbi, logs, eventName: 'ChallengeCreated' }).map((l) => ({
        id: Number(l.args.id), creator: l.args.creator.toLowerCase(), prizeAtomic: l.args.prize.toString(), deadline: Number(l.args.deadline),
        rulesHash: l.args.rulesHash, authNonce: l.args.authNonce, txHash: l.transactionHash, blockNumber: Number(l.blockNumber),
      }));
    },
    async status(id) {
      const c = await client.readContract({ address: contract, abi: challengesAbi, functionName: 'challenge', args: [BigInt(id)] });
      return { status: STATUS[c.status] ?? 'none', evaluator: c.evaluator, winner: c.winner, prize: c.prize };
    },
    async appointedEvaluator() {
      return client.readContract({ address: contract, abi: challengesAbi, functionName: 'evaluator' });
    },
    async challengeCount(atBlock) {
      return Number(await client.readContract({ address: contract, abi: challengesAbi, functionName: 'challengeCount', blockNumber: BigInt(atBlock) }));
    },
    async attemptsRecorder() {
      if (!attempts) throw new Error('attempts contract not configured');
      return getAddress(await client.readContract({ address: attempts, abi: attemptsAbi, functionName: 'recorder' }));
    },
    async attemptStage(attemptId) {
      if (!attempts) return 0;
      return Number(await client.readContract({ address: attempts, abi: attemptsAbi, functionName: 'stage', args: [attemptKey(attemptId)] })) as 0 | 1 | 2;
    },
    async prizeLimits() {
      const [min, max] = await Promise.all([
        client.readContract({ address: contract, abi: challengesAbi, functionName: 'minPrize' }),
        client.readContract({ address: contract, abi: challengesAbi, functionName: 'maxPrize' }),
      ]);
      return { min, max };
    },
    async prepare(call, options) {
      const data = encode(call), to = target(call);
      const [nonce, block, gas] = await Promise.all([
        options?.nonce ?? client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        client.getBlock({ blockTag: 'latest' }),
        client.estimateGas({ account: account.address, to, data }),
      ]);
      // Fresh fees for every transaction, never cached; at least Arc's floor.
      const base = block.baseFeePerGas ?? 0n;
      const fresh = base * 2n + PRIORITY_FEE_PER_GAS > ARC_MIN_FEE_PER_GAS ? base * 2n + PRIORITY_FEE_PER_GAS : ARC_MIN_FEE_PER_GAS;
      const maxFeePerGas = options?.minMaxFeePerGas && options.minMaxFeePerGas > fresh ? options.minMaxFeePerGas : fresh;
      // A replacement must also raise the tip, or nodes refuse it as underpriced.
      const maxPriorityFeePerGas = options?.minMaxFeePerGas ? PRIORITY_FEE_PER_GAS * 2n : PRIORITY_FEE_PER_GAS;
      const raw = await account.signTransaction({ type: 'eip1559', chainId: config.chainId, to, data, nonce,
        gas: gas + gas / 5n, maxFeePerGas, maxPriorityFeePerGas });
      return { hash: keccak256(raw), raw, nonce, maxFeePerGas };
    },
    async broadcast(raw) {
      try { await client.request({ method: 'eth_sendRawTransaction', params: [raw] }); }
      catch (error) {
        // Sent before (a retry after a restart): the receipt check decides what happened.
        if (/already known|already imported|known transaction|nonce too low/i.test(String((error as Error).message))) return;
        throw error;
      }
    },
    async receipt(hash) {
      try { const r = await client.getTransactionReceipt({ hash }); return r.status; }
      catch (error) { if ((error as Error).name === 'TransactionReceiptNotFoundError') return null; throw error; }
    },
    async known(hash) {
      try { await client.getTransaction({ hash }); return true; }
      catch (error) { if ((error as Error).name === 'TransactionNotFoundError') return false; throw error; }
    },
  };
}
