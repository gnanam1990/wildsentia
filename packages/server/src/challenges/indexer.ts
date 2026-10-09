import type { ChallengeChain } from './chain.js';
import type { ChallengeStore } from './store.js';

/**
 * Reads the contract's ChallengeCreated events into the database, in block ranges, resuming
 * from a stored cursor. Arc's finality is deterministic, so a mined block is never rolled back.
 */
export const MAX_BLOCK_RANGE = 2000;

export class ChallengeIndexer {
  #busy = false;
  constructor(private readonly store: ChallengeStore, private readonly chain: ChallengeChain, private readonly fromBlock: number) {}

  /** Reads up to MAX_BLOCK_RANGE new blocks; returns how many challenges it recorded. */
  async pollOnce(): Promise<number> {
    if (this.#busy) return 0;
    this.#busy = true;
    try {
      const from = (await this.store.cursor(this.chain.contract)) ?? this.fromBlock;
      const head = await this.chain.head();
      if (head < from) return 0;
      const to = Math.min(head, from + MAX_BLOCK_RANGE - 1);
      const events = await this.chain.createdEvents(from, to);
      for (const e of events) await this.store.recordCreated(this.chain.contract, e);
      await this.store.setCursor(this.chain.contract, to + 1);
      return events.length;
    } finally { this.#busy = false; }
  }
}
