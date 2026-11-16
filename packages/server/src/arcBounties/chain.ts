import { BaseError, createPublicClient, decodeErrorResult, encodeAbiParameters, encodeFunctionData, erc20Abi, fallback, getAddress, type Hex, http, type Transport, keccak256, parseEventLogs } from 'viem';
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
  | { fn: 'voidBounty'; id: Hex; recordHash: Hex; target: Hex; salt: Hex }
  /** Anyone may return an open bounty to the pool once it has expired; the evaluator does it for a stranded one. */
  | { fn: 'expire'; id: Hex };

export interface BountyChain {
  readonly contract: Hex;
  readonly evaluator: Hex;
  readonly chainId: number;
  /** Unreserved USDC in the pool, 6-decimal units. */
  pool(): Promise<bigint>;
  /** USDC held by open bounties, 6-decimal units. */
  reserved(): Promise<bigint>;
  /**
   * Everything ever paid into the pool (Funded) and taken out unreserved (Withdrawn) since a
   * block, read from the contract's events: what the public board shows trades funding.
   */
  flows(fromBlock: bigint): Promise<{ fundedAtomic: bigint; withdrawnAtomic: bigint; toBlock: bigint }>;
  /**
   * What the server checks before it sends anything: that its key is the contract's evaluator (a
   * rotated-out key is refused by the contract), and that the USDC token counts 6 decimals as every
   * amount here assumes (Arc's native USDC counts 18).
   */
  identity(): Promise<{ evaluator: Hex; usdcDecimals: number }>;
  /** The contract's bounty limits, 6-decimal units. */
  limits(): Promise<{ min: bigint; max: bigint }>;
  status(id: Hex): Promise<OnChainStatus>;
  /** Signs the call with the evaluator key at fresh fees; nothing is sent. */
  prepare(call: BountyCall): Promise<{ hash: Hex; raw: Hex }>;
  broadcast(raw: Hex): Promise<void>;
  /** The receipt's outcome, or null while the transaction is not mined (a hash, or an external signer's reference). */
  receipt(ref: string): Promise<'success' | 'reverted' | null>;
  /**
   * With an external signer (a Circle developer-controlled wallet): sends the call under an
   * idempotency key, so the same key never sends twice, and returns its reference (`circle:<id>`);
   * `prepare` and `broadcast` are not used. A contract refusal is raised by name before sending.
   */
  submit?(call: BountyCall, idempotencyKey: string): Promise<string>;
  /** The chain transaction hash behind an external signer's reference, once it is known. */
  hashOf?(ref: string): Promise<Hex | null>;
}

/** A signer outside this process (docs/2026-10-22-circle-evaluator.md): it holds the evaluator's key and sends for it. */
export interface ExternalSigner {
  readonly address: Hex;
  /** Sends `data` to `contract` under the idempotency key; the signer's transaction id. */
  send(contract: Hex, data: Hex, idempotencyKey: string): Promise<string>;
  /** The transaction's end (null while pending) and its hash once known. */
  state(id: string): Promise<{ done: 'success' | 'reverted' | null; txHash: Hex | null }>;
}
export const EXTERNAL_REF = 'circle:';

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

/** The most blocks one log query asks for (Arc's public RPC refuses wide ranges). */
const LOG_CHUNK = 9_000n;

/**
 * The RPC transport: one URL, or several separated by commas, tried in order (a dedicated provider
 * first and Arc's public RPC after it, which rate-limits: "Request exceeds defined limit").
 */
export function rpcTransport(rpcUrl: string) {
  const urls = rpcUrl.split(',').map((u) => u.trim()).filter(Boolean);
  if (!urls.length) throw new Error('no RPC URL');
  const one = (url: string) => hidingKey(url, http(url, { timeout: 15_000, retryCount: 2 }));
  return urls.length === 1 ? one(urls[0]!) : fallback(urls.map(one));
}

/**
 * A managed RPC carries its key in the URL's path (Alchemy's `/v2/<key>`), and viem writes the URL
 * into its errors, which the server logs. Each error from this transport has the URL's path and
 * query replaced, so a log shows the host and never the key.
 */
function hidingKey(url: string, transport: Transport): Transport {
  let shown: string;
  try {
    const u = new URL(url);
    if (u.pathname === '/' && !u.search && !u.username && !u.password) return transport;
    shown = `${u.protocol}//${u.host}/…`;
  } catch { return transport; }
  return ((options: Parameters<Transport>[0]) => {
    const inner = transport(options);
    return { ...inner, request: (async (args: Parameters<typeof inner.request>[0]) => {
      try { return await inner.request(args); } catch (error) { throw redactUrl(error, url, shown); }
    }) as typeof inner.request };
  }) as Transport;
}

/** The error and each cause, with every text naming `url` rewritten to name `shown`. */
export function redactUrl<T>(error: T, url: string, shown: string): T {
  const scrub = (v: unknown) => (typeof v === 'string' && v.includes(url) ? v.split(url).join(shown) : v);
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const o = e as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === 'cause') continue;
      const v = o[key];
      try {
        if (typeof v === 'string') o[key] = scrub(v);
        else if (Array.isArray(v)) o[key] = v.map(scrub);
      } catch { /* a read-only field */ }
    }
  }
  return error;
}

export function viemBountyChain(config: { rpcUrl: string; chainId: number; contract: Hex } & ({ evaluatorKey: Hex; signer?: undefined } | { signer: ExternalSigner; evaluatorKey?: undefined })): BountyChain {
  const client = createPublicClient({ cacheTime: 0, transport: rpcTransport(config.rpcUrl) });
  const signer = config.signer;
  const account = config.evaluatorKey ? privateKeyToAccount(config.evaluatorKey) : null;
  const evaluator = account ? account.address : getAddress(signer!.address);
  const contract = getAddress(config.contract);
  const read = <T>(functionName: 'pool' | 'reserved' | 'minAmount' | 'maxAmount') =>
    client.readContract({ address: contract, abi: bountiesAbi, functionName }) as Promise<T>;
  const encode = (call: BountyCall): Hex => {
    switch (call.fn) {
      case 'publish': return encodeFunctionData({ abi: bountiesAbi, functionName: 'publish',
        args: [call.id, call.amount, call.expiresAt, call.rulesHash, call.targetCommit] });
      case 'settle': return encodeFunctionData({ abi: bountiesAbi, functionName: 'settle',
        args: [call.id, OUTCOME[call.outcome], call.payee, call.recordHash, call.target, call.salt] });
      case 'voidBounty': return encodeFunctionData({ abi: bountiesAbi, functionName: 'voidBounty',
        args: [call.id, call.recordHash, call.target, call.salt] });
      case 'expire': return encodeFunctionData({ abi: bountiesAbi, functionName: 'expire', args: [call.id] });
    }
  };
  const chainReceipt = async (hash: Hex): Promise<'success' | 'reverted' | null> => {
    try { return (await client.getTransactionReceipt({ hash })).status; }
    catch (error) { if ((error as Error).name === 'TransactionReceiptNotFoundError') return null; throw error; }
  };
  return {
    contract, evaluator, chainId: config.chainId,
    pool: () => read<bigint>('pool'),
    reserved: () => read<bigint>('reserved'),
    async flows(fromBlock) {
      const head = await client.getBlockNumber();
      let funded = 0n, withdrawn = 0n;
      // The public RPC limits a log query's range: read it in chunks.
      for (let from = fromBlock; from <= head; from += LOG_CHUNK) {
        const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
        const logs = await client.getLogs({ address: contract, fromBlock: from, toBlock: to });
        for (const log of parseEventLogs({ abi: bountiesAbi, logs, eventName: ['Funded', 'Withdrawn'] })) {
          if (log.eventName === 'Funded') funded += log.args.amount; else withdrawn += log.args.amount;
        }
      }
      return { fundedAtomic: funded, withdrawnAtomic: withdrawn, toBlock: head };
    },
    async identity() {
      const [evaluator, usdc] = await Promise.all([
        client.readContract({ address: contract, abi: bountiesAbi, functionName: 'evaluator' }) as Promise<Hex>,
        client.readContract({ address: contract, abi: bountiesAbi, functionName: 'usdc' }) as Promise<Hex>,
      ]);
      const usdcDecimals = await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'decimals' });
      return { evaluator: getAddress(evaluator), usdcDecimals };
    },
    async limits() { const [min, max] = await Promise.all([read<bigint>('minAmount'), read<bigint>('maxAmount')]); return { min, max }; },
    async status(id) {
      const b = await client.readContract({ address: contract, abi: bountiesAbi, functionName: 'bounty', args: [id] });
      return STATUS[b.status] ?? 'none';
    },
    async prepare(call) {
      if (!account) throw new Error('an external signer sends this evaluator\'s transactions: use submit');
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
    async receipt(ref) {
      if (ref.startsWith(EXTERNAL_REF)) return signer ? (await signer.state(ref.slice(EXTERNAL_REF.length))).done : null;
      return chainReceipt(ref as Hex);
    },
    ...(signer ? {
      async submit(call: BountyCall, idempotencyKey: string) {
        const data = encode(call);
        // Refused by the contract? Say why, by name, before anything is sent.
        await client.estimateGas({ account: evaluator, to: contract, data }).catch((error: unknown) => { throw namedBountyRevert(error); });
        return `${EXTERNAL_REF}${await signer.send(contract, data, idempotencyKey)}`;
      },
      async hashOf(ref: string) {
        return ref.startsWith(EXTERNAL_REF) ? (await signer.state(ref.slice(EXTERNAL_REF.length))).txHash : ref as Hex;
      },
    } : {}),
  };
}
