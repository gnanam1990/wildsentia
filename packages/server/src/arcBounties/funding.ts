/**
 * Who funds whom on chain, as a check that a bounty's hunter and its prey are not one person
 * (docs/2026-11-14-funding-graph.md). Ratings and network checks are cheap to fake; money moving
 * between wallets is not. After Circle Research's Anduin paper (3 November 2026), which ranks agent
 * services by the payment graph instead of by ratings.
 *
 * Two wallets are linked when, among their USDC transfers of at least `minUsdc`:
 * - one sent to the other;
 * - one address sent to both (a shared funder); or
 * - both sent to one address (a shared cash-out).
 * A public hub joins strangers and links nobody: a contract (the bounty contract pays every winner),
 * an address the operator lists, or one with more transfers than `hubTransfers` (a faucet: Arc
 * Testnet's sends to millions).
 *
 * Only USDC counts: any contract can log a Transfer event naming any sender, so another token's
 * transfers could be forged to link an honest hunter to a prey. USDC is the chain's own system
 * contract. Below `minUsdc` (default 0.5) a transfer does not count, so linking a stranger to a prey
 * costs the griefer real money, paid to the people they would link.
 *
 * A fresh wallet has no history and so no links: this raises the cost of self-dealing (a second
 * wallet must never meet the first), it does not end it.
 */

/** A USDC transfer, in whole USDC. */
export interface Transfer { from: string; to: string; usdc: number }

/** Where the transfers come from: an explorer's index (Blockscout's API v2 serves Arc's). */
export interface FundingSource {
  /** Transfers into and out of a wallet, newest first, up to the source's own limit. */
  transfers(wallet: string): Promise<Transfer[]>;
  /** Whether an address is a contract, and how many token transfers it has made or taken. */
  profile(address: string): Promise<{ contract: boolean; transfers: number }>;
}

export type Link = { linked: true; via: string; how: 'direct' | 'funder' | 'cash-out' } | { linked: false };

export interface FundingGraphOptions {
  /** Addresses that link nobody: the bounty contract, the evaluator, a faucet the operator names. */
  ignore?: Iterable<string>;
  /** More token transfers than this make an address a public hub (default 1000). */
  hubTransfers?: number;
  /** Smaller transfers do not count (default 0.5 USDC). */
  minUsdc?: number;
  /** How long a wallet's transfers and an address's profile are kept (default 10 minutes). */
  ttlMs?: number;
  now?: () => number;
}

export class FundingGraph {
  readonly #ignore: Set<string>;
  readonly #hubTransfers: number;
  readonly #minUsdc: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #transfers = new Map<string, { at: number; value: Promise<Transfer[]> }>();
  readonly #hubs = new Map<string, { at: number; value: Promise<boolean> }>();

  constructor(private readonly source: FundingSource, options: FundingGraphOptions = {}) {
    this.#ignore = new Set([...(options.ignore ?? [])].map((a) => a.toLowerCase()));
    this.#hubTransfers = options.hubTransfers ?? 1000;
    this.#minUsdc = options.minUsdc ?? 0.5;
    this.#ttlMs = options.ttlMs ?? 600_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Whether two wallets are linked, and through which address. Throws when the source cannot be
   * read: the caller decides later, it never pays on an unread graph.
   */
  async linked(a: string, b: string): Promise<Link> {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    if (x === y) return { linked: true, via: x, how: 'direct' };
    const [tx, ty] = await Promise.all([this.#transfersOf(x), this.#transfersOf(y)]);
    if (tx.some((t) => t.from === y || t.to === y) || ty.some((t) => t.from === x || t.to === x)) return { linked: true, via: x, how: 'direct' };
    const shared = async (pick: (t: Transfer) => string, own: string, other: string, how: 'funder' | 'cash-out'): Promise<Link | null> => {
      const theirs = new Set(ty.filter((t) => (how === 'funder' ? t.to : t.from) === other).map(pick));
      const common = new Set(tx.filter((t) => (how === 'funder' ? t.to : t.from) === own).map(pick).filter((addr) => theirs.has(addr)));
      for (const addr of common) if (!(await this.#hub(addr))) return { linked: true, via: addr, how };
      return null;
    };
    return (await shared((t) => t.from, x, y, 'funder')) ?? (await shared((t) => t.to, x, y, 'cash-out')) ?? { linked: false };
  }

  async #transfersOf(wallet: string): Promise<Transfer[]> {
    return this.#cached(this.#transfers, wallet, async () => (await this.source.transfers(wallet))
      .filter((t) => t.usdc >= this.#minUsdc).map((t) => ({ from: t.from.toLowerCase(), to: t.to.toLowerCase(), usdc: t.usdc })));
  }

  async #hub(address: string): Promise<boolean> {
    if (this.#ignore.has(address)) return true;
    return this.#cached(this.#hubs, address, async () => {
      const p = await this.source.profile(address);
      return p.contract || p.transfers > this.#hubTransfers;
    });
  }

  /** A cached read; a failed one is forgotten at once, so the next asks the source again. */
  #cached<T>(cache: Map<string, { at: number; value: Promise<T> }>, key: string, read: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.value;
    const value = read();
    cache.set(key, { at: this.#now(), value });
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    if (cache.size > 5000) cache.delete(cache.keys().next().value!);
    return value;
  }
}

/** The zero address: mints and burns, which link nobody. */
const ZERO = '0x0000000000000000000000000000000000000000';
/** USDC on Arc: the chain's own system contract, whose transfers cannot be forged. */
export const ARC_USDC = '0x3600000000000000000000000000000000000000';

/**
 * USDC transfers from a Blockscout explorer's API v2 (Arc Testnet: https://explorer.testnet.arc.io/api/v2).
 * On Arc a native USDC payment is listed as a token transfer of the USDC system contract, so these
 * cover both. Every other token is left out. Reads up to `pages` pages of 50, newest first.
 */
export function blockscoutFunding(api: string, options: { token?: string; pages?: number; timeoutMs?: number; fetch?: typeof fetch } = {}): FundingSource {
  const base = api.replace(/\/$/, ''), pages = options.pages ?? 4, timeoutMs = options.timeoutMs ?? 10_000, get = options.fetch ?? fetch;
  const token = (options.token ?? ARC_USDC).toLowerCase();
  const read = async (path: string): Promise<Record<string, unknown>> => {
    const response = await get(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`explorer ${response.status} for ${path.split('?')[0]}`);
    return await response.json() as Record<string, unknown>;
  };
  const hashOf = (side: unknown): string | null => {
    const hash = (side as { hash?: unknown } | null)?.hash;
    return typeof hash === 'string' && /^0x[0-9a-fA-F]{40}$/.test(hash) ? hash : null;
  };
  return {
    async transfers(wallet) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('not a wallet address');
      const out: Transfer[] = [];
      let query = `?token=${token}`;
      for (let page = 0; page < pages; page++) {
        const body = await read(`/addresses/${wallet}/token-transfers${query}`);
        for (const raw of (body.items as unknown[] | undefined) ?? []) {
          const item = raw as { from?: unknown; to?: unknown; token?: { address_hash?: unknown; address?: unknown }; total?: { value?: unknown; decimals?: unknown } };
          // The filter is asked for, and checked again here: an explorer that ignored it must not let another token through.
          if (String(item.token?.address_hash ?? item.token?.address ?? '').toLowerCase() !== token) continue;
          const from = hashOf(item.from), to = hashOf(item.to);
          const usdc = Number(item.total?.value) / 10 ** Number(item.total?.decimals ?? 6);
          if (from && to && Number.isFinite(usdc) && from.toLowerCase() !== ZERO && to.toLowerCase() !== ZERO) out.push({ from, to, usdc });
        }
        const next = body.next_page_params as Record<string, unknown> | null | undefined;
        if (!next) break;
        query = `?${new URLSearchParams([['token', token], ...Object.entries(next).map(([k, v]): [string, string] => [k, String(v)])]).toString()}`;
      }
      return out;
    },
    async profile(address) {
      const [info, counters] = await Promise.all([read(`/addresses/${address}`), read(`/addresses/${address}/counters`)]);
      return { contract: info.is_contract === true, transfers: Number(counters.token_transfers_count ?? 0) || 0 };
    },
  };
}
