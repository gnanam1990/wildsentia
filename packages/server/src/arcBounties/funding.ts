/**
 * Who funds whom on chain, as a check that a bounty's hunter and its prey are not one person
 * (docs/2026-11-14-funding-graph.md). Ratings and network checks are cheap to fake; money moving
 * between wallets is not. After Circle Research's Anduin paper (3 November 2026), which ranks agent
 * services by the payment graph instead of by ratings.
 *
 * The hunter's wallet is linked to the prey's when, among their USDC transfers:
 * - one sent to the other;
 * - one address sent to both (a shared funder); or
 * - both sent to one address (a shared cash-out).
 * A flow (all one address sent another, summed, so funding split into small transfers still counts)
 * counts from `minUsdc` (default 0.5), so dust from a griefer does not; the hunter's own payment to
 * the prey counts at any amount, since nobody else can make it. Through a third address both sides
 * need the minimum: a hunter's small payment to some service cannot be paired by the prey's owner.
 *
 * A public hub joins strangers and links nobody, but only an address the operator names is one (the
 * bounty contract, the evaluator, a faucet). Nothing an address does on chain makes it a hub: a
 * colluder could deploy a contract to fund both wallets through, or pad their own address with spam
 * transfers, and their link would vanish.
 *
 * Only USDC counts: any contract can log a Transfer event naming any sender, so another token's
 * transfers could be forged to link an honest hunter to a prey. USDC is the chain's own system
 * contract. Linking a stranger to a prey costs a griefer at least `minUsdc` per flow, paid to the
 * people they would link.
 *
 * A fresh wallet has no history and so no links: this raises the cost of self-dealing (a second
 * wallet must never meet the first), it does not end it.
 */

/** A USDC transfer, in whole USDC; `id` (transaction and log index) tells one seen from both ends. */
export interface Transfer { id: string; from: string; to: string; usdc: number }

/** Where the transfers come from: an explorer's index (Blockscout's API v2 serves Arc's). */
export interface FundingSource {
  /** Every transfer into and out of a wallet; throws rather than return part of its history. */
  transfers(wallet: string): Promise<Transfer[]>;
}

/** The source cannot be reached (down, slow, refusing): every read waits, not only this wallet's. */
export class FundingUnavailable extends Error {
  readonly unavailable = true;
}

export type Link = { linked: true; via: string; how: 'direct' | 'funder' | 'cash-out' } | { linked: false };

export interface FundingGraphOptions {
  /** The hubs, which link nobody: the bounty contract, the evaluator, a faucet. No other address is one. */
  ignore?: Iterable<string>;
  /** A flow from one address to another counts at this total (default 0.5 USDC), unless the hunter sent it. */
  minUsdc?: number;
  /** How long a wallet's transfers are kept (default 10 minutes). */
  ttlMs?: number;
  /** How long a failure is kept: a wallet that could not be read, or the source while it is unavailable (default 1 minute). */
  failTtlMs?: number;
  now?: () => number;
}

export class FundingGraph {
  readonly #ignore: Set<string>;
  readonly #minUsdc: number;
  readonly #ttlMs: number;
  readonly #failTtlMs: number;
  readonly #now: () => number;
  readonly #transfers = new Map<string, { until: number; value: Promise<Transfer[]> }>();
  /** While the source is unavailable, every read fails at once instead of waiting on it again. */
  #down: { until: number; error: unknown } | null = null;

  constructor(private readonly source: FundingSource, options: FundingGraphOptions = {}) {
    this.#ignore = new Set([...(options.ignore ?? [])].map((a) => a.toLowerCase()));
    this.#minUsdc = options.minUsdc ?? 0.5;
    this.#ttlMs = options.ttlMs ?? 600_000;
    this.#failTtlMs = options.failTtlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Whether the hunter's wallet is linked to the prey's, and through which address. Not symmetric:
   * the hunter's own payment to the prey counts whatever its size, the prey's to the hunter only
   * from `minUsdc` up, so a prey's owner cannot void a hunter's kill by sending it a cent. Throws when
   * the source cannot be read: the caller decides later, it never pays on an unread graph.
   */
  async linked(hunter: string, prey: string): Promise<Link> {
    const [x, y] = [hunter.toLowerCase(), prey.toLowerCase()];
    if (x === y) return { linked: true, via: x, how: 'direct' };
    const [tx, ty] = await Promise.all([this.#transfersOf(x), this.#transfersOf(y)]);
    // What each address sent each other one, summed; a transfer between the two is in both lists, counted once.
    const flows = new Map<string, number>(), seen = new Set<string>();
    for (const t of [...tx, ...ty]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      flows.set(`${t.from}>${t.to}`, (flows.get(`${t.from}>${t.to}`) ?? 0) + t.usdc);
    }
    const counts = (from: string, to: string) => (flows.get(`${from}>${to}`) ?? 0) >= this.#minUsdc;
    if (flows.has(`${x}>${y}`) || counts(y, x)) return { linked: true, via: x, how: 'direct' };
    const others = new Set<string>();
    for (const t of [...tx, ...ty]) for (const a of [t.from, t.to]) if (a !== x && a !== y && !this.#ignore.has(a)) others.add(a);
    for (const how of ['funder', 'cash-out'] as const) {
      for (const a of others) {
        if (how === 'funder' ? counts(a, x) && counts(a, y) : counts(x, a) && counts(y, a)) return { linked: true, via: a, how };
      }
    }
    return { linked: false };
  }

  /**
   * A wallet's transfers, kept for `ttlMs`. A failed read is kept for `failTtlMs`, so the same
   * wallet is not asked again at once; a source that is unavailable fails every read for as long.
   */
  #transfersOf(wallet: string): Promise<Transfer[]> {
    const now = this.#now();
    const hit = this.#transfers.get(wallet);
    if (hit && now < hit.until) return hit.value;
    if (this.#down && now < this.#down.until) return Promise.reject(this.#down.error);
    const value = this.source.transfers(wallet)
      .then((list) => list.map((t) => ({ id: t.id, from: t.from.toLowerCase(), to: t.to.toLowerCase(), usdc: t.usdc })));
    this.#transfers.set(wallet, { until: now + this.#ttlMs, value });
    value.catch((error: unknown) => {
      const at = this.#now();
      if (this.#transfers.get(wallet)?.value === value) this.#transfers.set(wallet, { until: at + this.#failTtlMs, value });
      if ((error as { unavailable?: unknown } | null)?.unavailable === true) this.#down = { until: at + this.#failTtlMs, error };
    });
    if (this.#transfers.size > 5000) this.#transfers.delete(this.#transfers.keys().next().value!);
    return value;
  }
}

/** The zero address: mints and burns, which link nobody. */
const ZERO = '0x0000000000000000000000000000000000000000';
/** USDC on Arc: the chain's own system contract, whose transfers cannot be forged. */
export const ARC_USDC = '0x3600000000000000000000000000000000000000';
/** Arc Testnet's public faucet (faucet.circle.com), which has paid millions of wallets: a hub. */
export const ARC_TESTNET_FAUCET = '0x70e3fb28e1794bb91d5bceb7d66b731d0c61af8e';

/**
 * USDC transfers from a Blockscout explorer's API v2 (Arc Testnet: https://explorer.testnet.arc.io/api/v2).
 * On Arc a native USDC payment is listed as a token transfer of the USDC system contract, so these
 * cover both. Every other token is left out. Reads a wallet's whole history, page by page; a wallet
 * with more than `maxTransfers` (default 2000) is not read in part, since an old funding transfer
 * could be pushed out of a partial read by newer dust: the read fails and the decision waits.
 */
export function blockscoutFunding(api: string, options: { token?: string; maxTransfers?: number; timeoutMs?: number; fetch?: typeof fetch } = {}): FundingSource {
  const base = api.replace(/\/$/, ''), maxTransfers = options.maxTransfers ?? 2000, timeoutMs = options.timeoutMs ?? 10_000, get = options.fetch ?? fetch;
  const token = (options.token ?? ARC_USDC).toLowerCase();
  const read = async (path: string): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await get(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch (error) {
      throw new FundingUnavailable(`explorer unreachable: ${String((error as Error).message ?? error).split('\n')[0]}`);
    }
    if (!response.ok) throw new FundingUnavailable(`explorer ${response.status} for ${path.split('?')[0]}`);
    try { return await response.json() as Record<string, unknown>; } catch {
      throw new FundingUnavailable(`explorer gave no JSON for ${path.split('?')[0]}`);
    }
  };
  const hashOf = (side: unknown): string | null => {
    const hash = (side as { hash?: unknown } | null)?.hash;
    return typeof hash === 'string' && /^0x[0-9a-fA-F]{40}$/.test(hash) ? hash : null;
  };
  return {
    async transfers(wallet) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('not a wallet address');
      const out: Transfer[] = [];
      let query = `?token=${token}`, listed = 0;
      for (;;) {
        const body = await read(`/addresses/${wallet}/token-transfers${query}`);
        for (const raw of (body.items as unknown[] | undefined) ?? []) {
          listed++;
          const item = raw as { from?: unknown; to?: unknown; token?: { address_hash?: unknown; address?: unknown }; total?: { value?: unknown; decimals?: unknown };
            transaction_hash?: unknown; log_index?: unknown };
          // The filter is asked for, and checked again here: an explorer that ignored it must not let another token through.
          if (String(item.token?.address_hash ?? item.token?.address ?? '').toLowerCase() !== token) continue;
          const from = hashOf(item.from), to = hashOf(item.to);
          const usdc = Number(item.total?.value) / 10 ** Number(item.total?.decimals ?? 6);
          // The id tells a transfer seen from both wallets: without one, two different transfers could
          // count as one, so the whole read fails (the caller decides later) rather than guess.
          if (typeof item.transaction_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(item.transaction_hash)
            || !Number.isSafeInteger(Number(item.log_index)) || item.log_index === null || item.log_index === '') {
            throw new Error('explorer transfer without a transaction hash and log index');
          }
          const id = `${item.transaction_hash.toLowerCase()}:${Number(item.log_index)}`;
          if (from && to && Number.isFinite(usdc) && from.toLowerCase() !== ZERO && to.toLowerCase() !== ZERO) out.push({ id, from, to, usdc });
        }
        const next = body.next_page_params as Record<string, unknown> | null | undefined;
        if (!next) return out;
        if (listed >= maxTransfers) throw new Error(`wallet history longer than ${maxTransfers} transfers`);
        query = `?${new URLSearchParams([['token', token], ...Object.entries(next).map(([k, v]): [string, string] => [k, String(v)])]).toString()}`;
      }
    },
  };
}
