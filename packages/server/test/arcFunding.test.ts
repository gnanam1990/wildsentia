import { describe, expect, it } from 'vitest';
import { ARC_USDC, blockscoutFunding, FundingGraph, type FundingSource, type Transfer } from '../src/arcBounties/funding.js';

/**
 * The funding-graph check (docs/2026-11-14-funding-graph.md): a bounty's hunter and its prey are one
 * person when money links their wallets, whatever networks they register from.
 */
const HUNTER = '0x00000000000000000000000000000000000000a1', PREY = '0x00000000000000000000000000000000000000b2';
const OWNER = '0x00000000000000000000000000000000000000c3', FAUCET = '0x00000000000000000000000000000000000000f4';
const CONTRACT = '0x00000000000000000000000000000000000000d5', STRANGER = '0x00000000000000000000000000000000000000e6';

/** An explorer over a fixed list of transfers, counting its reads. */
function source(transfers: Transfer[], profiles: Record<string, { contract: boolean; transfers: number }> = {}) {
  const reads = { transfers: 0, profiles: 0 };
  let down = false;
  const s: FundingSource & { reads: typeof reads; down: (v: boolean) => void } = {
    reads, down: (v) => { down = v; },
    async transfers(wallet) {
      reads.transfers++;
      if (down) throw new Error('explorer 503');
      const w = wallet.toLowerCase();
      return transfers.filter((t) => t.from.toLowerCase() === w || t.to.toLowerCase() === w);
    },
    async profile(address) {
      reads.profiles++;
      if (down) throw new Error('explorer 503');
      return profiles[address.toLowerCase()] ?? { contract: false, transfers: 3 };
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

  it('does not link strangers through a faucet, a contract or an address the operator names', async () => {
    const transfers = [{ from: FAUCET, to: HUNTER, usdc: 5 }, { from: FAUCET, to: PREY, usdc: 5 }, { from: CONTRACT, to: HUNTER, usdc: 5 }, { from: CONTRACT, to: PREY, usdc: 5 },
      { from: OWNER, to: HUNTER, usdc: 5 }, { from: OWNER, to: PREY, usdc: 5 }];
    const profiles = { [FAUCET]: { contract: false, transfers: 3_992_582 }, [CONTRACT]: { contract: true, transfers: 7 } };
    expect(await new FundingGraph(source(transfers, profiles), { ignore: [OWNER] }).linked(HUNTER, PREY)).toEqual({ linked: false });
    // Without the operator's word the owner still links them.
    expect((await new FundingGraph(source(transfers, profiles)).linked(HUNTER, PREY)).linked).toBe(true);
    // Funded by different people, or by one only one of them knows: no link.
    expect(await new FundingGraph(source([{ from: OWNER, to: HUNTER, usdc: 5 }, { from: STRANGER, to: PREY, usdc: 5 }])).linked(HUNTER, PREY)).toEqual({ linked: false });
    // A transfer between the funder and a third wallet is not the prey's.
    expect(await new FundingGraph(source([{ from: OWNER, to: HUNTER, usdc: 5 }, { from: OWNER, to: STRANGER, usdc: 5 }, { from: PREY, to: STRANGER, usdc: 5 }])).linked(HUNTER, PREY))
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
    expect(s.reads).toEqual({ transfers: 2, profiles: 1 });
    now = 600_001; s.down(true);
    await expect(g.linked(HUNTER, PREY)).rejects.toThrow('explorer 503');
    // A failed read is not kept: the next asks again.
    s.down(false);
    expect((await g.linked(HUNTER, PREY)).linked).toBe(true);
  });
});

describe('Blockscout as the source', () => {
  const api = 'https://explorer.example/api/v2';
  /** Answers like Arc Testnet's explorer: two pages of transfers, then the counters. */
  const fake = (pages: Record<string, unknown>[], seen: string[]): typeof fetch => (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url.replace(api, ''));
    if (url.endsWith('/counters')) return new Response(JSON.stringify({ token_transfers_count: '3992582' }));
    if (/\/addresses\/0x[0-9a-fA-F]{40}$/.test(url)) return new Response(JSON.stringify({ is_contract: false }));
    if (url.includes('fail')) return new Response('', { status: 503 });
    return new Response(JSON.stringify(pages[url.includes('block_number=') ? 1 : 0]));
  }) as typeof fetch;

  const usdc = { address_hash: ARC_USDC }, amount = (value: string) => ({ value, decimals: '6' });

  it('reads every page of a wallet\'s USDC transfers (native USDC included), leaving out other tokens, mints and burns', async () => {
    const seen: string[] = [];
    const s = blockscoutFunding(api, { fetch: fake([
      { items: [{ from: { hash: OWNER }, to: { hash: HUNTER }, token: usdc, total: amount('5000000') },
        { from: { hash: '0x0000000000000000000000000000000000000000' }, to: { hash: HUNTER }, token: usdc, total: amount('1000000') },
        // Any contract can log a Transfer naming any sender: a forged "prey paid the hunter" in another token.
        { from: { hash: PREY }, to: { hash: HUNTER }, token: { address_hash: CONTRACT }, total: amount('9000000') }],
        next_page_params: { block_number: 70687710, index: 3 } },
      { items: [{ from: { hash: HUNTER }, to: { hash: STRANGER }, token: usdc, total: amount('500000') }], next_page_params: null },
    ], seen) });
    expect(await s.transfers(HUNTER)).toEqual([{ from: OWNER, to: HUNTER, usdc: 5 }, { from: HUNTER, to: STRANGER, usdc: 0.5 }]);
    expect(seen).toEqual([`/addresses/${HUNTER}/token-transfers?token=${ARC_USDC}`,
      `/addresses/${HUNTER}/token-transfers?token=${ARC_USDC}&block_number=70687710&index=3`]);
    expect(await s.profile(FAUCET)).toEqual({ contract: false, transfers: 3_992_582 });
  });

  it('fails on an explorer error and refuses anything but an address', async () => {
    const s = blockscoutFunding(`${api}/fail`, { fetch: fake([], []) });
    await expect(s.transfers(HUNTER)).rejects.toThrow('explorer 503');
    await expect(s.transfers('0x12/../../admin')).rejects.toThrow('not a wallet address');
  });
});
