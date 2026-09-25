import { describe, expect, it } from 'vitest';
import { BASE_CHAIN_ID, BASE_USDC, ERC20_TRANSFER_TOPIC, matchBaseUsdcReceipt, type ReceiptRpc } from '../src/baseReceipt.js';

const txHash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
const from = `0x${'1'.repeat(40)}`;
const to = `0x${'2'.repeat(40)}`;
const topic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const expected = { txHash, logIndex: 7, from, to, amountMicro: '5000001' };
const log = { address: BASE_USDC, topics: [ERC20_TRANSFER_TOPIC, topic(from), topic(to)], data: `0x${BigInt(expected.amountMicro).toString(16).padStart(64, '0')}`,
  transactionHash: txHash, blockHash, logIndex: '0x7', removed: false };
const receipt = { status: '0x1', transactionHash: txHash, blockNumber: '0x64', blockHash, logs: [log] };
function fixture(override: { chain?: unknown; receipt?: unknown; finalized?: unknown; canonical?: unknown } = {}): ReceiptRpc {
  return async (method, params) => {
    if (method === 'eth_chainId') return override.chain === undefined ? BASE_CHAIN_ID : override.chain;
    if (method === 'eth_getTransactionReceipt') return override.receipt === undefined ? receipt : override.receipt;
    if (params[0] === 'finalized') return override.finalized === undefined ? { number: '0x65', hash: `0x${'c'.repeat(64)}` } : override.finalized;
    return override.canonical === undefined ? { number: '0x64', hash: blockHash } : override.canonical;
  };
}
describe('read-only Base USDC receipt match', () => {
  it('matches one finalized canonical transfer with exact token, source, destination, micro amount, tx and log index', async () => {
    expect(await matchBaseUsdcReceipt(fixture(), expected)).toMatchObject({ matched: true, txHash, logIndex: 7, blockHash, token: BASE_USDC });
  });
  it('rejects wrong chain, pending, failed, unfinalized, reorged or uncertain RPC state', async () => {
    for (const altered of [
      { chain: '0x1' }, { receipt: null }, { receipt: { ...receipt, status: '0x0' } },
      { receipt: { ...receipt, transactionHash: `0x${'9'.repeat(64)}` } },
      { finalized: { number: '0x63' } }, { finalized: null },
      { canonical: { number: '0x64', hash: `0x${'d'.repeat(64)}` } }, { canonical: null },
    ]) expect((await matchBaseUsdcReceipt(fixture(altered), expected)).matched).toBe(false);
    expect(await matchBaseUsdcReceipt(async () => { throw new Error('timeout'); }, expected)).toEqual({ matched: false, reason: 'rpc_unavailable_or_uncertain' });
  });
  it('rejects bridged/fake tokens, foreign source, wrong claimant, amount, tx/log identity, removed or duplicate logs', async () => {
    const wrong: unknown[] = [
      { ...log, address: `0x${'3'.repeat(40)}` },
      { ...log, topics: [ERC20_TRANSFER_TOPIC, topic(`0x${'4'.repeat(40)}`), topic(to)] },
      { ...log, topics: [ERC20_TRANSFER_TOPIC, topic(from), topic(`0x${'5'.repeat(40)}`)] },
      { ...log, data: `0x${(BigInt(expected.amountMicro) + 1n).toString(16).padStart(64, '0')}` },
      { ...log, transactionHash: `0x${'6'.repeat(64)}` },
      { ...log, blockHash: `0x${'7'.repeat(64)}` },
      { ...log, logIndex: '0x8' },
      { ...log, removed: true },
      { ...log, topics: [ERC20_TRANSFER_TOPIC, topic(from)] },
    ];
    for (const alteredLog of wrong) expect((await matchBaseUsdcReceipt(fixture({ receipt: { ...receipt, logs: [alteredLog] } }), expected)).matched).toBe(false);
    expect((await matchBaseUsdcReceipt(fixture({ receipt: { ...receipt, logs: [log, log] } }), expected)).matched).toBe(false);
  });
  it('refuses malformed expected values before querying a provider', async () => {
    const never: ReceiptRpc = async () => { throw new Error('should not call'); };
    for (const bad of [{ ...expected, logIndex: -1 }, { ...expected, amountMicro: '5.1' }, { ...expected, txHash: 'bad' }])
      expect(await matchBaseUsdcReceipt(never, bad)).toEqual({ matched: false, reason: 'invalid_expected_payout' });
  });
});
