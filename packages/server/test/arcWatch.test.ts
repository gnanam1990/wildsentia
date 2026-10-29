import { describe, expect, it } from 'vitest';
import { toEventSelector, toFunctionSelector } from 'viem';
// @ts-expect-error: a plain .mjs tool without types
import { rpcOver, SELECTORS, TOPICS, watch } from '../../../tools/arc/watch.mjs';

const CONTRACT = '0x0741af75301873120bec5ceba3c18b78a1b89050';
const EVALUATOR = '0x0620fafbcbb6192c3182ea8b246eb5723bf18101', OWNER = '0x8a46da2d0a97ffb6b299f870348117b2f14b2d55';
const word = (value: string | bigint) => `0x${(typeof value === 'bigint' ? value.toString(16) : value.slice(2)).padStart(64, '0')}`;
const config = { contract: CONTRACT, evaluator: EVALUATOR, owner: OWNER, minutes: 90, minGasUsdc: 0.05 };
const KNOWN = `0x${'aa'.repeat(32)}`, UNKNOWN = `0x${'bb'.repeat(32)}`;

/** A stand-in chain: the contract's reads, a gas balance, a block every half second, and the given logs. */
function chain(over: { evaluator?: string; pendingOwner?: string; paused?: boolean; gasWei?: bigint; logs?: Array<{ topics: string[] }> } = {}) {
  const reads: Record<string, string> = {
    [SELECTORS.evaluator]: word(over.evaluator ?? EVALUATOR), [SELECTORS.owner]: word(OWNER),
    [SELECTORS.pendingOwner]: word(over.pendingOwner ?? `0x${'0'.repeat(40)}`), [SELECTORS.settlePaused]: word(over.paused ? 1n : 0n),
    [SELECTORS.pool]: word(4_500_000n), [SELECTORS.reserved]: word(1_000_000n),
  };
  const ranges: Array<[bigint, bigint]> = [];
  const rpc = async (method: string, params: any[]) => {
    if (method === 'eth_call') return reads[params[0].data];
    if (method === 'eth_getBalance') return `0x${(over.gasWei ?? 5n * 10n ** 17n).toString(16)}`;
    if (method === 'eth_blockNumber') return '0x100000';
    if (method === 'eth_getBlockByNumber') return { timestamp: `0x${(1_000_000 + Number(BigInt(params[0])) / 2).toString(16)}` };
    if (method === 'eth_getLogs') {
      ranges.push([BigInt(params[0].fromBlock), BigInt(params[0].toBlock)]);
      return ranges.length === 1 ? (over.logs ?? []).map((l) => ({ ...l, blockNumber: params[0].fromBlock, transactionHash: `0x${'cd'.repeat(32)}` })) : [];
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, ranges };
}
const known = async (id: string) => id === KNOWN;

describe('the Arc contract watch (tools/arc/watch.mjs)', () => {
  it("names the contract's events and reads by their real topics and selectors", () => {
    const events: Record<string, string> = {
      Withdrawn: 'Withdrawn(address,uint256)', BountyPublished: 'BountyPublished(bytes32,uint96,uint64,bytes32,bytes32)',
      BountyPaid: 'BountyPaid(bytes32,uint8,address,uint96,bytes32,bytes32)', BountyVoided: 'BountyVoided(bytes32,uint96,bytes32,bytes32)',
      BountyExpired: 'BountyExpired(bytes32,uint96)', EvaluatorChanged: 'EvaluatorChanged(address,address)', SettlePausedSet: 'SettlePausedSet(bool)',
      AmountLimitsSet: 'AmountLimitsSet(uint96,uint96)', OwnershipTransferStarted: 'OwnershipTransferStarted(address,address)',
      OwnershipTransferred: 'OwnershipTransferred(address,address)',
    };
    for (const [name, signature] of Object.entries(events)) expect(TOPICS[name]).toBe(toEventSelector(signature));
    for (const name of Object.keys(SELECTORS)) expect(SELECTORS[name]).toBe(toFunctionSelector(`${name}()`));
  });

  it('is quiet when the contract is as expected and every bounty is known', async () => {
    const { rpc, ranges } = chain({ logs: [{ topics: [TOPICS.BountyPublished, KNOWN] }, { topics: [TOPICS.BountyPaid, KNOWN, word(EVALUATOR)] }] });
    const { alerts, notes } = await watch(config, { rpc, known });
    expect(alerts).toEqual([]);
    expect(notes.join('\n')).toContain('pool 4.5 USDC, reserved 1 USDC');
    // 90 minutes at half a second a block, read in spans the public RPC accepts.
    expect(ranges[0]![0]).toBe(0x100000n - 10_800n);
    expect(ranges.at(-1)![1]).toBe(0x100000n);
    for (const [from, to] of ranges) expect(to - from).toBeLessThan(2000n);
  });

  it('alerts on a changed evaluator, a pending owner, a pause and low gas', async () => {
    const { rpc } = chain({ evaluator: `0x${'11'.repeat(20)}`, pendingOwner: `0x${'22'.repeat(20)}`, paused: true, gasWei: 10n ** 15n });
    const { alerts } = await watch(config, { rpc, known });
    expect(alerts).toEqual([
      `the evaluator is 0x${'11'.repeat(20)}, not ${EVALUATOR}`,
      `an ownership transfer to 0x${'22'.repeat(20)} is pending`,
      'settling is paused',
      'the evaluator has 0.001 USDC of gas, under 0.05',
    ]);
  });

  it("alerts on the owner's own moves and on a bounty the server does not know", async () => {
    const { rpc } = chain({ logs: [{ topics: [TOPICS.Withdrawn, word(OWNER)] }, { topics: [TOPICS.EvaluatorChanged, word(EVALUATOR), word(OWNER)] },
      { topics: [TOPICS.BountyPublished, UNKNOWN] }, { topics: [TOPICS.BountyPublished, KNOWN] }] });
    const { alerts } = await watch(config, { rpc, known });
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toMatch(/^Withdrawn in block/);
    expect(alerts[1]).toMatch(/^EvaluatorChanged in block/);
    expect(alerts[2]).toContain(`BountyPublished for a bounty the server does not know: ${UNKNOWN}`);
  });

  it('tries the next RPC when one fails, and again after a pause when rate-limited', async () => {
    const calls: string[] = [];
    let limited = 1;
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url === 'https://a') throw new Error('down');
      if (limited-- > 0) return new Response(JSON.stringify({ error: { code: -32011, message: 'rate limit exceeded' } }));
      return new Response(JSON.stringify({ result: '0x1' }));
    };
    const rpc = rpcOver(['https://a', 'https://b'], fetchImpl, async () => undefined);
    expect(await rpc('eth_blockNumber', [])).toBe('0x1');
    expect(calls).toEqual(['https://a', 'https://b', 'https://a', 'https://b']);
  });
});
