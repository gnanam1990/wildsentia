import { describe, expect, it } from 'vitest';
import { ARC_USDC, blockscoutFunding, FundingGraph, FundingUnavailable, type FundingSource, type Transfer } from '../src/arcBounties/funding.js';

/**
 * The funding-graph check (docs/2026-11-14-funding-graph.md): a bounty's hunter and its prey are one
 * person when money links their wallets, whatever networks they register from.
 */
const HUNTER = '0x00000000000000000000000000000000000000a1', PREY = '0x00000000000000000000000000000000000000b2';
const OWNER = '0x00000000000000000000000000000000000000c3', FAUCET = '0x00000000000000000000000000000000000000f4';
const CONTRACT = '0x00000000000000000000000000000000000000d5', STRANGER = '0x00000000000000000000000000000000000000e6';

/** An explorer over a fixed list of transfers, counting its reads. */
function source(list: Array<Omit<Transfer, 'id'>>) {
  const transfers: Transfer[] = list.map((t, i) => ({ id: `tx${i}`, ...t }));
  const reads = { transfers: 0 };
  let down: Error | null = null;
  const s: FundingSource & { reads: typeof reads; down: (e: Error | null) => void } = {
    reads, down: (e) => { down = e; },
    async transfers(wallet) {
      reads.transfers++;
      if (down) throw down;
      const w = wallet.toLowerCase();
      return transfers.filter((t) => t.from.toLowerCase() === w || t.to.toLowerCase() === w);
    },
  };
  return s;
}

describe('the funding graph', () => {
  it('links two wallets when one paid the other, either way and whatever the letter case', async () => {
    const g = new FundingGraph(source([{ from: HUNTER.toUpperCase().replace('0X', '0x'), to: PREY, usdc: 5 }]));
    expect(await g.linked(HUNTER, PREY)).toEqual({ linked: true, via: HUNTER, how: 'direct' });
    expect((await g.linked(PREY, HUNTER)).linked).toBe(true);
  });

  it('links two wallets one person funded, or that cashed out to one address', async () => {
    const funded = new FundingGraph(source([{ from: OWNER, to: HUNTER, usdc: 5 }, { from: OWNER, to: PREY, usdc: 5 }]));
    expect(await funded.linked(HUNTER, PREY)).toEqual({ linked: true, via: OWNER, how: 'funder' });
    const cashedOut = new FundingGraph(source([{ from: HUNTER, to: OWNER, usdc: 5 }, { from: PREY, to: OWNER, usdc: 5 }]));
    expect(await cashedOut.linked(HUNTER, PREY)).toEqual({ linked: true, via: OWNER, how: 'cash-out' });
  });

  it('does not link strangers through a hub the operator lists, and counts no other address a hub', async () => {
    const transfers = [{ from: FAUCET, to: HUNTER, usdc: 5 }, { from: FAUCET, to: PREY, usdc: 5 }, { from: CONTRACT, to: HUNTER, usdc: 5 }, { from: CONTRACT, to: PREY, usdc: 5 },
      { from: HUNTER, to: OWNER, usdc: 5 }, { from: PREY, to: OWNER, usdc: 5 }];
    expect(await new FundingGraph(source(transfers), { ignore: [FAUCET, CONTRACT, OWNER.toUpperCase().replace('0X', '0x')] }).linked(HUNTER, PREY)).toEqual({ linked: false });
    // A colluder's own contract, or an address padded with spam transfers, is not listed: it still links them.
    expect(await new FundingGraph(source(transfers), { ignore: [FAUCET, OWNER] }).linked(HUNTER, PREY)).toEqual({ linked: true, via: CONTRACT, how: 'funder' });
    expect(await new FundingGraph(source(transfers), { ignore: [FAUCET, CONTRACT] }).linked(HUNTER, PREY)).toEqual({ linked: true, via: OWNER, how: 'cash-out' });
    // Funded by different people, or by one only one of them knows: no link.
    expect(await new FundingGraph(source([{ from: OWNER, to: HUNTER, usdc: 5 }, { from: STRANGER, to: PREY, usdc: 5 }])).linked(HUNTER, PREY)).toEqual({ linked: false });
    // A transfer between the funder and a third wallet is not the prey's.
    expect(await new FundingGraph(source([{ from: OWNER, to: HUNTER, usdc: 5 }, { from: OWNER, to: STRANGER, usdc: 5 }, { from: PREY, to: STRANGER, usdc: 5 }])).linked(HUNTER, PREY))
      .toEqual({ linked: false });
  });

  it('sums what one address sent another, so funding split into small transfers still counts', async () => {
    const split = Array.from({ length: 6 }, () => [{ from: OWNER, to: HUNTER, usdc: 0.1 }, { from: OWNER, to: PREY, usdc: 0.1 }]).flat();
    expect(await new FundingGraph(source(split)).linked(HUNTER, PREY)).toEqual({ linked: true, via: OWNER, how: 'funder' });
    // A transfer between the two wallets is in both their lists: counted once, not twice.
    expect(await new FundingGraph(source([{ from: PREY, to: HUNTER, usdc: 0.3 }])).linked(HUNTER, PREY)).toEqual({ linked: false });
  });

  it('counts whatever the hunter paid the prey, but not a cent the prey sends it, nor a hunter\'s small payment the prey pairs', async () => {
    expect((await new FundingGraph(source([{ from: HUNTER, to: PREY, usdc: 0.01 }])).linked(HUNTER, PREY)).linked).toBe(true);
    // The prey's owner sends the hunter a cent: no link.
    expect(await new FundingGraph(source([{ from: PREY, to: HUNTER, usdc: 0.01 }])).linked(HUNTER, PREY)).toEqual({ linked: false });
    // The hunter paid some service a little; the prey's owner pays it 1 USDC to pair them: no link.
    expect(await new FundingGraph(source([{ from: HUNTER, to: OWNER, usdc: 0.01 }, { from: PREY, to: OWNER, usdc: 1 }])).linked(HUNTER, PREY))
      .toEqual({ linked: false });
    // Both cashed out real money to one address: linked.
    expect(await new FundingGraph(source([{ from: HUNTER, to: OWNER, usdc: 0.3 }, { from: HUNTER, to: OWNER, usdc: 0.3 }, { from: PREY, to: OWNER, usdc: 1 }]))
      .linked(HUNTER, PREY)).toEqual({ linked: true, via: OWNER, how: 'cash-out' });
    expect(await new FundingGraph(source([{ from: HUNTER, to: OWNER, usdc: 2 }, { from: PREY, to: OWNER, usdc: 0.01 }])).linked(HUNTER, PREY))
      .toEqual({ linked: false });
  });

  it('does not count dust: linking a stranger to a prey costs the griefer real money, paid to them', async () => {
    const dust = [{ from: PREY, to: HUNTER, usdc: 0.01 }, { from: OWNER, to: HUNTER, usdc: 0.49 }, { from: OWNER, to: PREY, usdc: 5 }];
    expect(await new FundingGraph(source(dust)).linked(HUNTER, PREY)).toEqual({ linked: false });
    expect((await new FundingGraph(source(dust), { minUsdc: 0.01 }).linked(HUNTER, PREY)).linked).toBe(true);
  });

  it('keeps what it read for ten minutes, and throws rather than answer while the explorer is down', async () => {
    let now = 0;
    const s = source([{ from: OWNER, to: HUNTER, usdc: 5 }, { from: OWNER, to: PREY, usdc: 5 }]);
    const g = new FundingGraph(s, { now: () => now });
    await g.linked(HUNTER, PREY);
    await g.linked(PREY, HUNTER);
    expect(s.reads).toEqual({ transfers: 2 });
    now = 600_001; s.down(new FundingUnavailable('explorer 503'));
    await expect(g.linked(HUNTER, PREY)).rejects.toThrow('explorer 503');
    expect(s.reads.transfers).toBe(4);
    // While it is down every read fails at once, a wallet never asked included: nothing waits on it again.
    await expect(g.linked(HUNTER, STRANGER)).rejects.toThrow('explorer 503');
    s.down(null);
    await expect(g.linked(HUNTER, PREY)).rejects.toThrow('explorer 503');
    expect(s.reads.transfers).toBe(4);
    // A minute on, it is asked again.
    now += 60_001;
    expect((await g.linked(HUNTER, PREY)).linked).toBe(true);
    expect(s.reads.transfers).toBe(6);
  });

  it('keeps one wallet\'s failed read for a minute without stopping the others', async () => {
    let now = 0;
    const s = source([{ from: OWNER, to: HUNTER, usdc: 5 }, { from: OWNER, to: PREY, usdc: 5 }]);
    const g = new FundingGraph(s, { now: () => now });
    s.down(new Error('wallet history longer than 2000 transfers'));
    await expect(g.linked(HUNTER, PREY)).rejects.toThrow('longer than');
    s.down(null);
    // The hunter's own read is kept failed for a minute; other wallets are still read.
    await expect(g.linked(HUNTER, STRANGER)).rejects.toThrow('longer than');
    const before = s.reads.transfers;
    expect(await g.linked(OWNER, STRANGER)).toEqual({ linked: false });
    expect(s.reads.transfers).toBe(before + 1);
    now += 60_001;
    expect(await g.linked(HUNTER, PREY)).toEqual({ linked: true, via: OWNER, how: 'funder' });
  });
});

describe('Blockscout as the source', () => {
  const api = 'https://explorer.example/api/v2';
  /** Answers like Arc Testnet's explorer: page n+1 is asked for with `index=n` (page 0 without). */
  const fake = (pages: Record<string, unknown>[], seen: string[]): typeof fetch => (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url.replace(api, ''));
    if (url.includes('fail')) return new Response('', { status: 503 });
    if (url.includes('down')) throw new TypeError('fetch failed');
    const index = /[?&]index=(\d+)/.exec(url);
    return new Response(JSON.stringify(pages[index ? Number(index[1]) + 1 : 0]));
  }) as typeof fetch;

  const usdc = { address_hash: ARC_USDC }, amount = (value: string) => ({ value, decimals: '6' });

  it('reads every page of a wallet\'s USDC transfers (native USDC included), leaving out other tokens, mints and burns', async () => {
    const seen: string[] = [];
    const s = blockscoutFunding(api, { fetch: fake([
      { items: [{ from: { hash: OWNER }, to: { hash: HUNTER }, token: usdc, total: amount('5000000'), transaction_hash: `0x${'a'.repeat(64)}`, log_index: 2 },
        { from: { hash: '0x0000000000000000000000000000000000000000' }, to: { hash: HUNTER }, token: usdc, total: amount('1000000'), transaction_hash: `0x${'c'.repeat(64)}`, log_index: 0 },
        // Any contract can log a Transfer naming any sender: a forged "prey paid the hunter" in another token.
        { from: { hash: PREY }, to: { hash: HUNTER }, token: { address_hash: CONTRACT }, total: amount('9000000') }],
        next_page_params: { block_number: 70687710, index: 0 } },
      { items: [{ from: { hash: HUNTER }, to: { hash: STRANGER }, token: usdc, total: amount('500000'), transaction_hash: `0x${'b'.repeat(64)}`, log_index: 0 }], next_page_params: null },
    ], seen) });
    expect(await s.transfers(HUNTER)).toEqual([{ id: `0x${'a'.repeat(64)}:2`, from: OWNER, to: HUNTER, usdc: 5 }, { id: `0x${'b'.repeat(64)}:0`, from: HUNTER, to: STRANGER, usdc: 0.5 }]);
    expect(seen).toEqual([`/addresses/${HUNTER}/token-transfers?token=${ARC_USDC}`,
      `/addresses/${HUNTER}/token-transfers?token=${ARC_USDC}&block_number=70687710&index=0`]);
  });

  it('reads past newer dust to an old funding transfer, and fails rather than read a longer history in part', async () => {
    // 200 dust transfers sent to the prey after its owner funded it: four pages of 50, the funding on the fifth.
    const dust = (page: number) => Array.from({ length: 50 }, (_, i) => ({ from: { hash: STRANGER }, to: { hash: PREY }, token: usdc, total: amount('1'),
      transaction_hash: `0x${(page * 50 + i + 1).toString(16).padStart(64, '0')}`, log_index: 0 }));
    const pages = [0, 1, 2, 3].map((n) => ({ items: dust(n), next_page_params: { block_number: 1, index: n } }));
    pages.push({ items: [{ from: { hash: OWNER }, to: { hash: PREY }, token: usdc, total: amount('5000000'), transaction_hash: `0x${'f'.repeat(64)}`, log_index: 1 }] as never,
      next_page_params: null as never });
    const funded = await blockscoutFunding(api, { fetch: fake(pages, []) }).transfers(PREY);
    expect(funded).toHaveLength(201);
    expect(funded.at(-1)).toEqual({ id: `0x${'f'.repeat(64)}:1`, from: OWNER, to: PREY, usdc: 5 });
    // With a cap below the history, the read fails: the decision waits, it is never paid on part of the history.
    await expect(blockscoutFunding(api, { maxTransfers: 150, fetch: fake(pages, []) }).transfers(PREY)).rejects.toThrow('longer than 150 transfers');
    // A history that ends at the cap is read whole.
    const seen: string[] = [];
    expect(await blockscoutFunding(api, { maxTransfers: 201, fetch: fake(pages, seen) }).transfers(PREY)).toHaveLength(201);
    expect(seen).toHaveLength(5);
  });

  it('fails rather than guess when a transfer comes without a transaction hash and log index', async () => {
    const bare = blockscoutFunding(api, { fetch: fake([{ items: [{ from: { hash: OWNER }, to: { hash: HUNTER }, token: usdc, total: amount('5000000') }],
      next_page_params: null }], []) });
    await expect(bare.transfers(HUNTER)).rejects.toThrow('without a transaction hash');
  });

  it('fails on an explorer error, as unavailable when it is down, and refuses anything but an address', async () => {
    const s = blockscoutFunding(`${api}/fail`, { fetch: fake([], []) });
    await expect(s.transfers(HUNTER)).rejects.toThrow(new FundingUnavailable(`explorer 503 for /addresses/${HUNTER}/token-transfers`));
    await expect(blockscoutFunding(`${api}/down`, { fetch: fake([], []) }).transfers(HUNTER)).rejects.toBeInstanceOf(FundingUnavailable);
    await expect(s.transfers('0x12/../../admin')).rejects.toThrow('not a wallet address');
    // A wallet the explorer cannot list is that wallet's failure, not the explorer's.
    const bare = blockscoutFunding(api, { fetch: fake([{ items: [{ from: { hash: OWNER }, to: { hash: HUNTER }, token: usdc, total: amount('5') }], next_page_params: null }], []) });
    await expect(bare.transfers(HUNTER)).rejects.not.toBeInstanceOf(FundingUnavailable);
  });
});
