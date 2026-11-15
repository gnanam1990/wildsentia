import type { Pool } from '../db/pool.js';
import { FundingUnavailable, type FundingSource, type Transfer } from './funding.js';

/**
 * Arc USDC transfers into and out of players' wallets, read from Arc's own RPC and kept in Postgres
 * (migration 038, docs/2026-11-15-arc-mainnet-readiness.md): the funding graph's source on Arc
 * Mainnet, whose explorer refuses servers.
 *
 * Every USDC movement on Arc, native or through the ERC-20 interface, is logged as a Transfer by the
 * system emitter, in native 18 decimals; no contract can log from that address. The index reads those
 * logs for the wallets it watches (as sender, then as recipient, by indexed topic), a range of blocks
 * at a time, from `fromBlock` to the head less `confirmations`, and keeps each transfer once by
 * transaction and log index. Wallets near the head are read first, so a new wallet's backfill never
 * holds up the others' answers. A wallet is answered only once read to the head the index last saw;
 * before that, or while the RPC cannot be reached, it throws and the caller decides later. A wallet
 * the RPC will not return even one block and one wallet at a time (flooded in a block) is set aside,
 * and its links stay unknown, so nothing involving it is paid.
 *
 * Each wallet's history is summed per pair of addresses: however many transfers a griefer sends, a
 * wallet's list grows by one entry per address that sent it, and nothing is cut off.
 */

/** Arc's system emitter, which logs every USDC Transfer (docs.arc.io, EVM differences). */
export const ARC_USDC_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface RawLog { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }

/** What the index needs of an RPC. `logs` throws a RangeTooLarge when the node wants a smaller range. */
export interface LogReader {
  head(): Promise<bigint>;
  logs(filter: { fromBlock: bigint; toBlock: bigint; topics: Array<string | string[] | null> }): Promise<RawLog[]>;
}

export class RangeTooLarge extends Error {}

/** A JSON-RPC log reader. A refusal for size is a RangeTooLarge; anything else, an unreachable node, is FundingUnavailable. */
export function rpcLogReader(url: string, options: { timeoutMs?: number; fetch?: typeof fetch } = {}): LogReader {
  const get = options.fetch ?? fetch, timeoutMs = options.timeoutMs ?? 20_000;
  let id = 0;
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    let response: Response;
    try {
      response = await get(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    } catch (error) { throw new FundingUnavailable(`rpc unreachable: ${String((error as Error).message ?? error).split('\n')[0]}`); }
    if (!response.ok) throw new FundingUnavailable(`rpc ${response.status} for ${method}`);
    const body = await response.json().catch(() => null) as { result?: T; error?: { code?: number; message?: string } } | null;
    if (!body) throw new FundingUnavailable(`rpc gave no JSON for ${method}`);
    if (body.error) {
      const message = String(body.error.message ?? '');
      if (/range too large|too many|limit exceeded|query returned more than|block range/i.test(message)) throw new RangeTooLarge(message);
      throw new FundingUnavailable(`rpc error ${body.error.code ?? ''} for ${method}: ${message.slice(0, 120)}`);
    }
    return body.result as T;
  };
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  return {
    head: async () => BigInt(await call<string>('eth_blockNumber', [])),
    logs: (f) => call<RawLog[]>('eth_getLogs', [{ address: ARC_USDC_EMITTER, fromBlock: hex(f.fromBlock), toBlock: hex(f.toBlock), topics: f.topics }]),
  };
}

export interface UsdcIndexOptions {
  /** The first block read for a wallet (default 0, the chain's start). */
  fromBlock?: bigint;
  /** The most blocks one request asks for (default 5000, Arc's public RPC's limit); halved while the node refuses. */
  span?: bigint;
  /** Blocks left behind the head, against reorganisations (default 2; Arc's finality is immediate). */
  confirmations?: bigint;
  /** A wallet is answered once read to within this many blocks of the head last seen (default 0: to it). */
  maxLagBlocks?: bigint;
  /** Wallets read to within this many blocks of the head are read on first, before any backfill (default 50000). */
  nearBlocks?: bigint;
  /** Wallets in one request's topic list (default 50). */
  batch?: number;
  /** The head is current for this long; past it every answer waits (default 2 minutes). */
  staleMs?: number;
  now?: () => number;
}

const pad = (wallet: string) => `0x${wallet.slice(2).toLowerCase().padStart(64, '0')}`;
const fromTopic = (topic: string | undefined): string | null => topic && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null;

export class UsdcIndex implements FundingSource {
  readonly #fromBlock: bigint;
  readonly #maxSpan: bigint;
  readonly #confirmations: bigint;
  readonly #maxLag: bigint;
  readonly #near: bigint;
  readonly #batch: number;
  readonly #staleMs: number;
  readonly #now: () => number;
  #span: bigint;
  #head: { block: bigint; at: number } | null = null;
  #timer: NodeJS.Timeout | null = null;
  #pauseUntil = 0;

  constructor(private readonly pool: Pool, readonly chainId: number, private readonly reader: LogReader, options: UsdcIndexOptions = {}) {
    this.#fromBlock = options.fromBlock ?? 0n;
    this.#maxSpan = this.#span = options.span ?? 5000n;
    this.#confirmations = options.confirmations ?? 2n;
    this.#maxLag = options.maxLagBlocks ?? 0n;
    this.#near = options.nearBlocks ?? 50_000n;
    this.#batch = options.batch ?? 50;
    this.#staleMs = options.staleMs ?? 120_000;
    this.#now = options.now ?? Date.now;
  }

  /** Starts reading a wallet's history, if it is not read already. */
  async watch(wallet: string): Promise<void> {
    if (!ADDRESS.test(wallet)) throw new Error('not a wallet address');
    await this.pool.query(`insert into arc_usdc_watch (chain_id, wallet, scanned_to) values ($1, $2, $3) on conflict do nothing`,
      [this.chainId, wallet.toLowerCase(), (this.#fromBlock - 1n).toString()]);
  }

  /** Watches every wallet a player proved: read before it is first asked about. */
  async watchProven(): Promise<void> {
    await this.pool.query(`insert into arc_usdc_watch (chain_id, wallet, scanned_to)
      select $1, lower(wallet), $2 from live_agents where wallet_proven and wallet ~ '^0x[0-9a-fA-F]{40}$' on conflict do nothing`,
    [this.chainId, (this.#fromBlock - 1n).toString()]);
  }

  /**
   * Reads on for up to `budgetMs`: first the wallets near the head, then those furthest behind, all
   * those at the same block together, so a new wallet catches up and then joins the rest. Returns
   * the ranges read.
   */
  async step(budgetMs = 4000): Promise<number> {
    const started = this.#now();
    const head = (await this.reader.head()) - this.#confirmations;
    this.#head = { block: head, at: this.#now() };
    let ranges = 0;
    for (const near of [true, false]) {
      while (this.#now() - started < budgetMs) {
        const { rows } = await this.pool.query<{ scanned_to: string; wallets: string[] }>(`select scanned_to, array_agg(wallet order by wallet) as wallets
          from arc_usdc_watch where chain_id = $1 and scanned_to < $2 and stuck_at is null and ($3::bigint is null or scanned_to >= $3)
          group by scanned_to order by scanned_to limit 1`, [this.chainId, head.toString(), near ? (head - this.#near).toString() : null]);
        const group = rows[0];
        if (!group) break;
        const scannedTo = BigInt(group.scanned_to), from = scannedTo + 1n;
        const to = from + this.#span - 1n < head ? from + this.#span - 1n : head;
        let read: { logs: RawLog[]; stuck: string[] };
        try { read = await this.#read(group.wallets, from, to); } catch (error) {
          if (error instanceof RangeTooLarge && this.#span > 1n) { this.#span /= 2n; continue; }
          throw error;
        }
        await this.#record(read.logs, group.wallets.filter((w) => !read.stuck.includes(w)), read.stuck, scannedTo, to);
        ranges++;
        if (this.#span < this.#maxSpan) this.#span = this.#span * 2n > this.#maxSpan ? this.#maxSpan : this.#span * 2n;
      }
    }
    return ranges;
  }

  /**
   * The wallets' transfers in a range. A one-block range the node still refuses is read again for
   * half the wallets at a time, down to one: a wallet refused alone is stuck, the rest read on.
   */
  async #read(wallets: string[], from: bigint, to: bigint): Promise<{ logs: RawLog[]; stuck: string[] }> {
    try {
      const logs: RawLog[] = [];
      for (let i = 0; i < wallets.length; i += this.#batch) {
        const topics = wallets.slice(i, i + this.#batch).map(pad);
        logs.push(...await this.reader.logs({ fromBlock: from, toBlock: to, topics: [TRANSFER, topics] }));
        logs.push(...await this.reader.logs({ fromBlock: from, toBlock: to, topics: [TRANSFER, null, topics] }));
      }
      return { logs, stuck: [] };
    } catch (error) {
      if (!(error instanceof RangeTooLarge) || from < to) throw error;
      if (wallets.length === 1) return { logs: [], stuck: wallets };
      const half = Math.ceil(wallets.length / 2);
      const [a, b] = [await this.#read(wallets.slice(0, half), from, to), await this.#read(wallets.slice(half), from, to)];
      return { logs: [...a.logs, ...b.logs], stuck: [...a.stuck, ...b.stuck] };
    }
  }

  /** One range's transfers and the wallets' new mark, together: a range is never half kept. */
  async #record(logs: RawLog[], wallets: string[], stuck: string[], scannedTo: bigint, to: bigint): Promise<void> {
    const rows: Array<[string, number, string, string, string, string]> = [];
    for (const log of logs) {
      if (log.address.toLowerCase() !== ARC_USDC_EMITTER || log.topics[0] !== TRANSFER || log.topics.length !== 3) continue;
      const from = fromTopic(log.topics[1]), recipient = fromTopic(log.topics[2]);
      if (!from || !recipient || from === ZERO || recipient === ZERO || !/^0x[0-9a-fA-F]{1,64}$/.test(log.data)) continue;
      if (!/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) throw new Error('rpc log without a transaction hash');
      rows.push([log.transactionHash.toLowerCase(), Number(BigInt(log.logIndex)), BigInt(log.blockNumber).toString(), from, recipient, BigInt(log.data).toString()]);
    }
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        await db.query(`insert into arc_usdc_transfers (chain_id, tx_hash, log_index, block_number, from_addr, to_addr, value_wei)
          select $1, * from unnest($2::text[], $3::int[], $4::bigint[], $5::text[], $6::text[], $7::numeric[]) on conflict do nothing`,
        [this.chainId, ...[0, 1, 2, 3, 4, 5].map((k) => chunk.map((r) => r[k]))]);
      }
      await db.query('update arc_usdc_watch set scanned_to = $4 where chain_id = $1 and wallet = any($2) and scanned_to = $3',
        [this.chainId, wallets, scannedTo.toString(), to.toString()]);
      if (stuck.length > 0) {
        await db.query('update arc_usdc_watch set stuck_at = $3 where chain_id = $1 and wallet = any($2)', [this.chainId, stuck, (scannedTo + 1n).toString()]);
        console.error(`[arc-bounty] USDC index: ${stuck.join(', ')} unreadable at block ${scannedTo + 1n}: set aside, its links unknown`);
      }
      await db.query('commit');
    } catch (error) {
      await db.query('rollback').catch(() => undefined);
      throw error;
    } finally { db.release(); }
  }

  /** A wallet's USDC flows, one per pair of addresses, summed; throws until it is read to near the head. */
  async transfers(wallet: string): Promise<Transfer[]> {
    if (!ADDRESS.test(wallet)) throw new Error('not a wallet address');
    const w = wallet.toLowerCase();
    await this.watch(w);
    if (!this.#head || this.#now() - this.#head.at > this.#staleMs) throw new FundingUnavailable('the USDC index is not current');
    const mark = (await this.pool.query<{ scanned_to: string; stuck_at: string | null }>('select scanned_to, stuck_at from arc_usdc_watch where chain_id = $1 and wallet = $2',
      [this.chainId, w])).rows[0]!;
    if (mark.stuck_at !== null) throw new Error(`wallet history unreadable at block ${mark.stuck_at}`);
    if (BigInt(mark.scanned_to) < this.#head.block - this.#maxLag) throw new Error('wallet not indexed yet');
    const { rows } = await this.pool.query<{ from_addr: string; to_addr: string; value: string }>(`select from_addr, to_addr, sum(value_wei)::text as value
      from arc_usdc_transfers where chain_id = $1 and (from_addr = $2 or to_addr = $2) group by from_addr, to_addr`, [this.chainId, w]);
    // One entry a pair: the same id from both wallets' lists, so the graph counts it once.
    return rows.map((r) => ({ id: `${r.from_addr}>${r.to_addr}`, from: r.from_addr, to: r.to_addr, usdc: Number(BigInt(r.value) / 1_000_000_000_000n) / 1e6 }));
  }

  /** Reads on in the background every `intervalMs`, one step at a time, watching new proven wallets each minute. */
  start(intervalMs = 5000): void {
    if (this.#timer) return;
    let running = false, lastWatch = 0;
    this.#timer = setInterval(() => {
      if (running || this.#now() < this.#pauseUntil) return;
      running = true;
      void (async () => {
        if (this.#now() - lastWatch > 60_000) { await this.watchProven(); lastWatch = this.#now(); }
        await this.step(Math.max(1000, intervalMs - 1000));
      })().catch((error: unknown) => {
        // A node refusing or down: try again in half a minute.
        this.#pauseUntil = this.#now() + 30_000;
        console.error(`[arc-bounty] USDC index: ${String((error as Error).message ?? error).split('\n')[0]}`);
      }).finally(() => { running = false; });
    }, intervalMs);
    this.#timer.unref();
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }
}
