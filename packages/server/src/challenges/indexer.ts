import type { ChallengeChain } from './chain.js';
import type { ChallengeStore } from './store.js';

/**
 * Reads the contract's ChallengeCreated events (and each settlement's transaction) into the database, in block ranges, resuming
 * from a stored cursor. Arc's finality is deterministic, but an RPC endpoint behind a load
 * balancer can answer getLogs from a node a block or two behind the head it reported. So the
 * indexer stays a few blocks back, and if the contract has created more challenges than were
 * indexed, it reads again from the start (recording an event twice changes nothing).
 */
export const MAX_BLOCK_RANGE = 2000;
export const INDEX_LAG_BLOCKS = 3;

export class ChallengeIndexer {
  #busy = false;
  constructor(private readonly store: ChallengeStore, private readonly chain: ChallengeChain, private readonly fromBlock: number) {}

  /** Reads up to MAX_BLOCK_RANGE new blocks; returns how many challenges it recorded. */
  async pollOnce(): Promise<number> {
    if (this.#busy) return 0;
    this.#busy = true;
    try {
      const from = (await this.store.cursor(this.chain.contract)) ?? this.fromBlock;
      const safeHead = (await this.chain.head()) - INDEX_LAG_BLOCKS;
      let recorded = 0;
      if (safeHead >= from) {
        const to = Math.min(safeHead, from + MAX_BLOCK_RANGE - 1);
        const { created, settled } = await this.chain.events(from, to);
        for (const e of created) {
          const { evaluator } = await this.chain.status(e.id);
          await this.store.recordCreated(this.chain.contract, e, { challenge: evaluator, ours: this.chain.evaluator });
          recorded++;
        }
        // The payout or refund's own transaction, even when it was not the one the server last sent.
        for (const e of settled) await this.store.recordSettledTx(this.chain.contract, e.id, e.txHash);
        await this.store.setCursor(this.chain.contract, to + 1);
        if (to < safeHead) return recorded; // more to read before checking for gaps
      }
      // Caught up: if the contract had more challenges by the safe head than are indexed, a node skipped some.
      if (safeHead >= 0 && (await this.chain.challengeCount(safeHead)) > (await this.store.maxChallengeId(this.chain.contract))) {
        console.error('[challenges] indexer found a gap; reading again from the start');
        await this.store.resetCursor(this.chain.contract, this.fromBlock);
      }
      return recorded;
    } finally { this.#busy = false; }
  }
}
