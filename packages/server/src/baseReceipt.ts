import { keccak_256 } from '@noble/hashes/sha3.js';

/** Circle-issued native USDC on Base Mainnet, not bridged USDbC. */
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_CHAIN_ID = '0x2105';
export const ERC20_TRANSFER_TOPIC = `0x${Buffer.from(keccak_256(new TextEncoder().encode('Transfer(address,address,uint256)'))).toString('hex')}`;
export type ReceiptRpc = (method: 'eth_chainId' | 'eth_getTransactionReceipt' | 'eth_getBlockByNumber', params: unknown[]) => Promise<unknown>;
export interface ExpectedPayout { txHash: string; logIndex: number; from: string; to: string; amountMicro: string }
export type ReceiptMatch = { matched: true; txHash: string; logIndex: number; blockNumber: string; blockHash: string; token: string }
  | { matched: false; reason: string };

const hash32 = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const quantity = (v: unknown): bigint | null => typeof v === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v) ? BigInt(v) : null;
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const topicAddress = (v: unknown): string | null => hash32(v) && /^0x0{24}/i.test(v) ? `0x${v.slice(26).toLowerCase()}` : null;

/** Point-in-time, read-only RPC evidence. Any missing/inconsistent field fails closed. */
export async function matchBaseUsdcReceipt(rpc: ReceiptRpc, expected: ExpectedPayout): Promise<ReceiptMatch> {
  if (!hash32(expected.txHash) || !Number.isSafeInteger(expected.logIndex) || expected.logIndex < 0
    || !address(expected.from) || !address(expected.to) || !/^[1-9][0-9]*$/.test(expected.amountMicro))
    return { matched: false, reason: 'invalid_expected_payout' };
  try {
    if ((await rpc('eth_chainId', [])) !== BASE_CHAIN_ID) return { matched: false, reason: 'wrong_chain' };
    const receipt = record(await rpc('eth_getTransactionReceipt', [expected.txHash]));
    if (!receipt) return { matched: false, reason: 'receipt_pending_or_missing' };
    if (receipt.status !== '0x1' || !hash32(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== expected.txHash.toLowerCase())
      return { matched: false, reason: 'receipt_failed_or_mismatched' };
    const blockNumber = quantity(receipt.blockNumber), receiptBlockHash = receipt.blockHash;
    if (blockNumber === null || !hash32(receiptBlockHash) || !Array.isArray(receipt.logs))
      return { matched: false, reason: 'receipt_incomplete' };
    const finalized = record(await rpc('eth_getBlockByNumber', ['finalized', false]));
    if (!finalized || quantity(finalized.number) === null || quantity(finalized.number)! < blockNumber)
      return { matched: false, reason: 'not_finalized' };
    const canonical = record(await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]));
    if (!canonical || canonical.number !== receipt.blockNumber || !hash32(canonical.hash)
      || canonical.hash.toLowerCase() !== receiptBlockHash.toLowerCase())
      return { matched: false, reason: 'block_reorg_or_rpc_inconsistent' };
    const matches = receipt.logs.filter((item: unknown) => {
      const log = record(item), topics = log?.topics;
      if (!log || log.removed === true || !Array.isArray(topics) || topics.length !== 3) return false;
      const value = typeof log.data === 'string' && /^0x[0-9a-fA-F]{64}$/.test(log.data) ? BigInt(log.data) : null;
      return address(log.address) && log.address.toLowerCase() === BASE_USDC
        && hash32(log.transactionHash) && log.transactionHash.toLowerCase() === expected.txHash.toLowerCase()
        && hash32(log.blockHash) && log.blockHash.toLowerCase() === receiptBlockHash.toLowerCase()
        && quantity(log.logIndex) === BigInt(expected.logIndex)
        && typeof topics[0] === 'string' && topics[0].toLowerCase() === ERC20_TRANSFER_TOPIC
        && topicAddress(topics[1]) === expected.from.toLowerCase()
        && topicAddress(topics[2]) === expected.to.toLowerCase()
        && value === BigInt(expected.amountMicro);
    });
    if (matches.length !== 1) return { matched: false, reason: 'transfer_log_not_unique_or_mismatched' };
    return { matched: true, txHash: expected.txHash.toLowerCase(), logIndex: expected.logIndex,
      blockNumber: receipt.blockNumber as string, blockHash: receiptBlockHash.toLowerCase(), token: BASE_USDC };
  } catch { return { matched: false, reason: 'rpc_unavailable_or_uncertain' }; }
}

/** Operator-configured HTTPS RPC only; never accepts a request-supplied URL or sends a transaction. */
export function baseReceiptRpc(url: string): ReceiptRpc {
  return async (method, params) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error('rpc_http_failure');
    const body: unknown = await response.json();
    const data = record(body);
    if (!data || data.jsonrpc !== '2.0' || data.id !== 1 || 'error' in data || !('result' in data)) throw new Error('rpc_invalid_response');
    return data.result;
  };
}
