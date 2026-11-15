import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { FundingGraph, FundingUnavailable } from '../src/arcBounties/funding.js';
import { ARC_USDC_EMITTER, RangeTooLarge, rpcLogReader, UsdcIndex, type LogReader, type RawLog } from '../src/arcBounties/usdcIndex.js';
import { testDatabaseUrl } from './testDatabase.js';

/**
 * The funding graph's source on Arc Mainnet (docs/2026-11-15-arc-mainnet-readiness.md): USDC
 * transfers of the wallets players proved, read from the RPC's logs and summed per pair.
 */
const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HUNTER = '0x00000000000000000000000000000000000000a1', PREY = '0x00000000000000000000000000000000000000b2';
const OWNER = '0x00000000000000000000000000000000000000c3', GRIEFER = '0x00000000000000000000000000000000000000e6';
const topic = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
const usdc = (n: number) => `0x${(BigInt(Math.round(n * 1e6)) * 1_000_000_000_000n).toString(16).padStart(64, '0')}`;

/** A node over a fixed chain of transfers: filters as eth_getLogs does, refuses ranges above `limit`, counts requests. */
function node(limit = 5000n) {
  const logs: RawLog[] = [];
  let head = 0n, n = 0;
  const reader: LogReader & { requests: number; add: (block: bigint, from: string, to: string, amount: number, extra?: Partial<RawLog>) => void; setHead: (b: bigint) => void } = {
    requests: 0,
    add: (block, from, to, amount, extra = {}) => { logs.push({ address: ARC_USDC_EMITTER, topics: [TRANSFER, topic(from), topic(to)], data: usdc(amount),
      blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${(++n).toString(16).padStart(64, '0')}`, logIndex: '0x0', ...extra }); },
    setHead: (b) => { head = b; },
    head: async () => head,
    async logs(f) {
      reader.requests++;
      if (f.toBlock - f.fromBlock + 1n > limit) throw new RangeTooLarge('requested range too large');
      const [, senders, recipients] = f.topics as [string, string[] | null, string[] | undefined];
      return logs.filter((l) => BigInt(l.blockNumber) >= f.fromBlock && BigInt(l.blockNumber) <= f.toBlock
        && (!senders || senders.includes(l.topics[1]!)) && (!recipients || recipients.includes(l.topics[2]!)));
    },
  };
  return reader;
}

maybe('the Arc USDC index', () => {
  let now: number;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate arc_usdc_transfers, arc_usdc_watch');
    now = 1_000_000;
  });
  const indexOf = (reader: LogReader, options = {}) => new UsdcIndex(pool!, 5042, reader, { confirmations: 0n, now: () => now, ...options });
  const catchUp = async (index: UsdcIndex) => { while (await index.step(60_000) > 0) { /* on to the head */ } };

  it('reads a wallet\'s whole USDC history from the chain\'s start, summed per pair, each transfer once', async () => {
    const chain = node();
    chain.add(10n, OWNER, HUNTER, 3); chain.add(12_000n, OWNER, HUNTER, 2); chain.add(30_000n, HUNTER, PREY, 0.01);
    // Mints and burns, and anything but the system emitter's Transfer, are not transfers between people.
    chain.add(31_000n, '0x0000000000000000000000000000000000000000', HUNTER, 9);
    chain.add(31_001n, PREY, HUNTER, 9, { address: '0x3600000000000000000000000000000000000000' });
    chain.setHead(40_000n);
    const index = indexOf(chain);
    await index.watch(HUNTER); await index.watch(PREY.toUpperCase().replace('0X', '0x'));
    await catchUp(index);
    expect(new Set(await index.transfers(HUNTER))).toEqual(new Set([{ id: `${OWNER}>${HUNTER}`, from: OWNER, to: HUNTER, usdc: 5 },
      { id: `${HUNTER}>${PREY}`, from: HUNTER, to: PREY, usdc: 0.01 }]));
    // The transfer between the two watched wallets was read from both ends, and kept once.
    expect((await pool!.query('select count(*)::int as n from arc_usdc_transfers')).rows[0].n).toBe(3);
    // Read again, nothing is added: a range read twice adds nothing.
    await pool!.query('update arc_usdc_watch set scanned_to = -1');
    await catchUp(index);
    expect((await pool!.query('select count(*)::int as n from arc_usdc_transfers')).rows[0].n).toBe(3);
  });

  it('answers only a wallet read to near the head, and nothing while the node has not been heard from', async () => {
    const chain = node();
    chain.setHead(1_000_000n);
    const index = indexOf(chain);
    await expect(index.transfers(HUNTER)).rejects.toBeInstanceOf(FundingUnavailable);
    await index.step(0);
    await expect(index.transfers(HUNTER)).rejects.toThrow('wallet not indexed yet');
    await catchUp(index);
    expect(await index.transfers(HUNTER)).toEqual([]);
    now += 120_001;
    await expect(index.transfers(HUNTER)).rejects.toThrow('not current');
    await expect(index.transfers('0x12/../admin')).rejects.toThrow('not a wallet address');
  });

  it('halves its range while the node refuses one as too large, and grows it back', async () => {
    const chain = node(1200n);
    chain.add(9_999n, OWNER, PREY, 5);
    chain.setHead(20_000n);
    const index = indexOf(chain);
    await index.watch(PREY);
    await catchUp(index);
    expect(await index.transfers(PREY)).toEqual([{ id: `${OWNER}>${PREY}`, from: OWNER, to: PREY, usdc: 5 }]);
  });

  it('lets a new wallet catch up and then read with the rest, two requests a range for all of them', async () => {
    const chain = node();
    chain.setHead(50_000n);
    const index = indexOf(chain);
    await index.watch(HUNTER);
    await catchUp(index);
    chain.add(1n, OWNER, PREY, 4);
    await index.watch(PREY);
    chain.setHead(60_000n);
    await catchUp(index);
    const marks = (await pool!.query('select wallet, scanned_to::text from arc_usdc_watch order by wallet')).rows;
    expect(marks).toEqual([{ wallet: HUNTER, scanned_to: '60000' }, { wallet: PREY, scanned_to: '60000' }]);
    const before = chain.requests;
    chain.setHead(65_000n);
    await catchUp(index);
    expect(chain.requests - before).toBe(2);
    expect(await index.transfers(PREY)).toEqual([{ id: `${OWNER}>${PREY}`, from: OWNER, to: PREY, usdc: 4 }]);
  });

  it('feeds the funding graph: a funder found past any amount of dust, a griefer\'s dust one entry, nothing cut off', async () => {
    const chain = node();
    chain.add(5n, OWNER, HUNTER, 5); chain.add(6n, OWNER, PREY, 5);
    for (let i = 0; i < 3000; i++) chain.add(1000n + BigInt(i), GRIEFER, PREY, 0.000001);
    chain.setHead(10_000n);
    const index = indexOf(chain);
    await index.watch(HUNTER); await index.watch(PREY);
    await catchUp(index);
    const flows = await index.transfers(PREY);
    expect(flows).toHaveLength(2);
    expect(await new FundingGraph(index).linked(HUNTER, PREY)).toEqual({ linked: true, via: OWNER, how: 'funder' });
  }, 30_000);
});

describe('the RPC log reader', () => {
  const answer = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it('reads the head and the system emitter\'s logs, and tells a refusal for size from a node that is down', async () => {
    const asked: unknown[] = [];
    const ok = rpcLogReader('https://rpc.example', { fetch: (async (_u: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: (JSON.parse(String(init.body)) as { method: string }).method === 'eth_blockNumber' ? '0x1de4a86' : [] }));
    }) as typeof fetch });
    expect(await ok.head()).toBe(31_345_286n);
    await ok.logs({ fromBlock: 1n, toBlock: 5000n, topics: [TRANSFER, null, [topic(PREY)]] });
    expect(asked[1]).toMatchObject({ method: 'eth_getLogs', params: [{ address: ARC_USDC_EMITTER, fromBlock: '0x1', toBlock: '0x1388', topics: [TRANSFER, null, [topic(PREY)]] }] });
    await expect(rpcLogReader('https://rpc.example', { fetch: answer({ error: { code: -32012, message: 'requested range too large' } }) })
      .logs({ fromBlock: 0n, toBlock: 1n, topics: [] })).rejects.toBeInstanceOf(RangeTooLarge);
    await expect(rpcLogReader('https://rpc.example', { fetch: answer({ error: { code: -32011, message: 'request limit reached' } }) }).head())
      .rejects.toBeInstanceOf(FundingUnavailable);
    await expect(rpcLogReader('https://rpc.example', { fetch: answer({}, 429) }).head()).rejects.toBeInstanceOf(FundingUnavailable);
  });
});
