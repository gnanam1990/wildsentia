import type { ChainCall, ChallengeChain } from './chain.js';
import type { ChainOp, ChallengeStore, Hex } from './store.js';

/**
 * Sends the queued chain operations (resolve, refund, relayed create) one at a time, durably:
 * the signed transaction's hash is stored before it is broadcast, and before every send the
 * contract's own state is read, so a restart never pays twice or forgets a payment. The
 * contract makes a double payout impossible anyway; this keeps the database in step with it.
 */
/** Failed tries (a transaction the contract refuses to estimate) before an operation is given up. */
export const MAX_TRIES = 6;
/** A sent transaction the node no longer knows after this long was dropped: sign it again. */
export const DROPPED_AFTER_MS = 120_000;

export class ChainOps {
  #busy = false;
  constructor(private readonly store: ChallengeStore, private readonly chain: ChallengeChain,
    private readonly clock: () => number = Date.now) {}

  /** One pass over every active operation. Safe to call on a timer; overlapping calls skip. */
  async processOnce(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (const op of await this.store.activeOps()) {
        try { await this.#step(op); }
        catch (error) { console.error(`[challenges] ${op.kind} ${op.id} step failed`, (error as Error).message); }
      }
    } finally { this.#busy = false; }
  }

  async #step(op: ChainOp): Promise<void> {
    // Back off after failed tries: 10 s, 20 s, 40 s...
    if (op.tries > 0 && op.status === 'pending' && this.clock() - op.updatedAt.getTime() < 10_000 * 2 ** (op.tries - 1)) return;
    if (op.status === 'sent') return this.#checkSent(op);
    if (await this.#alreadyDone(op)) return;
    if (op.tries >= MAX_TRIES) return this.#fail(op, op.lastError ?? 'too_many_tries');
    const call = await this.#call(op);
    if (!call) return;
    let tx: { hash: Hex; raw: Hex };
    try { tx = await this.chain.prepare(call); }
    catch (error) { return this.store.retryOp(op.id, `prepare: ${(error as Error).message}`, true); }
    await this.store.markOpSent(op.id, tx.hash);
    try { await this.chain.broadcast(tx.raw); }
    catch (error) { return this.store.retryOp(op.id, `broadcast: ${(error as Error).message}`, false); }
  }

  /** What the contract already shows: if the work is done (by us before a restart, or anyone), record it. */
  async #alreadyDone(op: ChainOp): Promise<boolean> {
    if (op.kind === 'relay_create') {
      const draft = await this.store.draft(op.draftId!);
      if (draft?.relayedAt) { await this.store.markOpConfirmed(op.id); return true; }
      return false;
    }
    const onChain = await this.chain.status(op.challengeId!);
    if (onChain.status === 'resolved') {
      if (op.kind === 'resolve') await this.store.setStatus(op.challengeId!, ['won'], 'paid');
      else await this.store.setStatus(op.challengeId!, ['open', 'unrecognised', 'unpaid', 'refunding', 'won'], 'paid');
      await this.store.markOpConfirmed(op.id);
      return true;
    }
    if (onChain.status === 'refunded') {
      await this.store.setStatus(op.challengeId!, ['open', 'unrecognised', 'unpaid', 'refunding', 'won'], 'refunded');
      if (op.kind === 'refund') await this.store.markOpConfirmed(op.id);
      else await this.store.markOpFailed(op.id, 'already_refunded');
      return true;
    }
    return false;
  }

  async #call(op: ChainOp): Promise<ChainCall | null> {
    const p = op.payload as Record<string, string>;
    switch (op.kind) {
      case 'resolve': return { fn: 'resolve', id: op.challengeId!, winner: p.winner as Hex, resultHash: p.resultHash as Hex };
      case 'refund': return { fn: 'refund', id: op.challengeId! };
      case 'relay_create':
        if (Number(p.validBefore) * 1000 <= this.clock()) { await this.#fail(op, 'authorization_expired'); return null; }
        return { fn: 'createWithAuthorization', creator: p.creator as Hex, rulesHash: p.rulesHash as Hex, prize: BigInt(p.prize!),
          deadline: BigInt(p.deadline!), salt: p.salt as Hex, validAfter: BigInt(p.validAfter!), validBefore: BigInt(p.validBefore!),
          signature: p.signature as Hex };
    }
  }

  async #checkSent(op: ChainOp): Promise<void> {
    const outcome = await this.chain.receipt(op.txHash!);
    if (outcome === 'success') {
      await this.store.markOpConfirmed(op.id);
      if (op.kind === 'resolve') await this.store.setStatus(op.challengeId!, ['won'], 'paid', op.txHash!);
      if (op.kind === 'refund') await this.store.setStatus(op.challengeId!, ['open', 'unrecognised', 'unpaid', 'refunding'], 'refunded', op.txHash!);
      return;
    }
    if (outcome === 'reverted') {
      // Someone else may have settled it first; otherwise it is a real failure.
      if (await this.#alreadyDone(op)) return;
      if (op.tries >= MAX_TRIES || op.kind === 'resolve') return this.#fail(op, 'reverted');
      return this.store.retryOp(op.id, 'reverted', false);
    }
    if (this.clock() - op.updatedAt.getTime() > DROPPED_AFTER_MS && !(await this.chain.known(op.txHash!))) {
      await this.store.retryOp(op.id, 'dropped', false);
    }
  }

  async #fail(op: ChainOp, reason: string): Promise<void> {
    await this.store.markOpFailed(op.id, reason);
    // A winner who cannot be paid (a blocklisted address, a window that closed): the prize refunds.
    if (op.kind === 'resolve') await this.store.setStatus(op.challengeId!, ['won'], 'unpaid');
    console.error(`[challenges] ${op.kind} ${op.id} failed: ${reason}`);
  }
}
