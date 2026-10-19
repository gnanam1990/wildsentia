import { BaseError, createPublicClient, decodeErrorResult, encodeAbiParameters, encodeFunctionData, getAddress, type Hex, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bountiesAbi } from '../challenges/bountiesAbi.js';
import { ARC_MIN_FEE_PER_GAS, PRIORITY_FEE_PER_GAS } from '../challenges/chain.js';

/**
 * The WildsentiaBounties contract as the server sees it (docs/2026-10-19-congo-arc-bounties-design.md):
 * reading the pool and a bounty's state, and signing the evaluator's publish, settle and void. The
 * contract decides each bounty once, so a transaction sent twice after a restart is refused, never
 * paid twice.
 */

/** WildsentiaBounties.Status. */
export type OnChainStatus = 'none' | 'open' | 'paid' | 'voided' | 'expired';
const STATUS: OnChainStatus[] = ['none', 'open', 'paid', 'voided', 'expired'];
/** WildsentiaBounties.Outcome: 1 the hunter's agent is paid, 2 the prey's. */
export const OUTCOME = { predator: 1, survived: 2 } as const;

export type BountyCall =
  | { fn: 'publish'; id: Hex; amount: bigint; expiresAt: bigint; rulesHash: Hex; targetCommit: Hex }
  | { fn: 'settle'; id: Hex; outcome: 'predator' | 'survived'; payee: Hex; recordHash: Hex; target: Hex; salt: Hex }
  | { fn: 'voidBounty'; id: Hex; recordHash: Hex; target: Hex; salt: Hex };

export interface BountyChain {
  readonly contract: Hex;
  readonly evaluator: Hex;
  readonly chainId: number;
  /** Unreserved USDC in the pool, 6-decimal units. */
  pool(): Promise<bigint>;
  /** The contract's bounty limits, 6-decimal units. */
  limits(): Promise<{ min: bigint; max: bigint }>;
  status(id: Hex): Promise<OnChainStatus>;
  /** Signs the call with the evaluator key at fresh fees; nothing is sent. */
  prepare(call: BountyCall): Promise<{ hash: Hex; raw: Hex }>;
  broadcast(raw: Hex): Promise<void>;
  /** The receipt's outcome, or null while the transaction is not mined. */
  receipt(hash: Hex): Promise<'success' | 'reverted' | null>;
}

/** The commit `publish` takes: keccak256(abi.encode(target, salt)), as the contract's `commitOf`. */
export function targetCommit(target: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [target, salt]));
}

/** A contract refusal by name ("execution reverted: PoolTooSmall()"), so it reads in the logs. */
export function namedBountyRevert(error: unknown): unknown {
  if (!(error instanceof BaseError)) return error;
  const carrier = error.walk((e) => typeof (e as { data?: unknown }).data === 'string' && /^0x[0-9a-fA-F]{8}/.test((e as { data: string }).data));
  const data = (carrier as { data?: Hex } | null)?.data;
  if (!data) return error;
  try { return new Error(`execution reverted: ${decodeErrorResult({ abi: bountiesAbi, data }).errorName}()`); }
  catch { return error; }
}

export function viemBountyChain(config: { rpcUrl: string; chainId: number; contract: Hex; evaluatorKey: Hex }): BountyChain {
  const client = createPublicClient({ cacheTime: 0, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  const account = privateKeyToAccount(config.evaluatorKey);
  const contract = getAddress(config.contract);
  const read = <T>(functionName: 'pool' | 'minAmount' | 'maxAmount') =>
    client.readContract({ address: contract, abi: bountiesAbi, functionName }) as Promise<T>;
  const encode = (call: BountyCall): Hex => {
    switch (call.fn) {
      case 'publish': return encodeFunctionData({ abi: bountiesAbi, functionName: 'publish',
        args: [call.id, call.amount, call.expiresAt, call.rulesHash, call.targetCommit] });
      case 'settle': return encodeFunctionData({ abi: bountiesAbi, functionName: 'settle',
        args: [call.id, OUTCOME[call.outcome], call.payee, call.recordHash, call.target, call.salt] });
      case 'voidBounty': return encodeFunctionData({ abi: bountiesAbi, functionName: 'voidBounty',
        args: [call.id, call.recordHash, call.target, call.salt] });
    }
  };
  return {
    contract, evaluator: account.address, chainId: config.chainId,
    pool: () => read<bigint>('pool'),
    async limits() { const [min, max] = await Promise.all([read<bigint>('minAmount'), read<bigint>('maxAmount')]); return { min, max }; },
    async status(id) {
      const b = await client.readContract({ address: contract, abi: bountiesAbi, functionName: 'bounty', args: [id] });
      return STATUS[b.status] ?? 'none';
    },
    async prepare(call) {
      const data = encode(call);
      const [nonce, block, gas] = await Promise.all([
        client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        client.getBlock({ blockTag: 'latest' }),
        client.estimateGas({ account: account.address, to: contract, data }).catch((error: unknown) => { throw namedBountyRevert(error); }),
      ]);
      // Fresh fees for every transaction, never cached; at least Arc's floor.
      const base = block.baseFeePerGas ?? 0n;
      const fresh = base * 2n + PRIORITY_FEE_PER_GAS;
      const maxFeePerGas = fresh > ARC_MIN_FEE_PER_GAS ? fresh : ARC_MIN_FEE_PER_GAS;
      const raw = await account.signTransaction({ type: 'eip1559', chainId: config.chainId, to: contract, data, nonce,
        gas: gas + gas / 5n, maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS });
      return { hash: keccak256(raw), raw };
    },
    async broadcast(raw) {
      try { await client.request({ method: 'eth_sendRawTransaction', params: [raw] }); }
      catch (error) {
        if (/already known|already imported|known transaction|nonce too low/i.test(String((error as Error).message))) return;
        throw namedBountyRevert(error);
      }
    },
    async receipt(hash) {
      try { return (await client.getTransactionReceipt({ hash })).status; }
      catch (error) { if ((error as Error).name === 'TransactionReceiptNotFoundError') return null; throw error; }
    },
  };
}
