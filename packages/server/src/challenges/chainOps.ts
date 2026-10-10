import type { AttemptOutcome, ChainCall, ChallengeChain, PrepareOptions } from './chain.js';
import { GRACE_SECONDS } from './engine.js';
import type { ChainOp, ChallengeStore, Hex } from './store.js';

/**
 * Sends the queued chain operations (resolve, refund, relayed create, then attempt records) one
 * at a time, durably:
 * the signed transaction's hash, nonce and fee cap are stored before it is broadcast, and before
 * every send the contract's own state is read, so a restart never pays twice or forgets a
 * payment. The contract makes a double payout impossible anyway; this keeps the database in
 * step with it and makes sure a winner is paid whenever the contract still allows it.
 */

/** Refused refunds and relays (the contract reverts) before an operation is given up. */
export const MAX_TRIES = 6;
/** A sent transaction the node no longer knows after this long was dropped: sign it again. */
export const DROPPED_AFTER_MS = 120_000;
/** A sent transaction the node knows but has not mined after this long is replaced with a higher fee. */
export const STUCK_AFTER_MS = 90_000;
/** The longest wait between tries. */
const MAX_BACKOFF_MS = 5 * 60_000;
/**
 * How long attempt records wait after the attempts contract refuses our key (its owner moved the
 * recorder): not counted as tries and never given up, so they go out once the key is the recorder again.
 */
export const RECORDS_PAUSE_MS = 5 * 60_000;
const isRecord = (op: ChainOp) => op.kind === 'record_start' || op.kind === 'record_end';

/** Reverts that mean this payout can never succeed, whatever is retried. */
const PERMANENT_RESOLVE = /BadWinner|NotEvaluator|ResolveWindowClosed/;
/** A contract refusal, as opposed to the RPC endpoint failing (timeouts, rate limits, outages). */
const isRevert = (message: string) => /revert/i.test(message);

export class ChainOps {
  #busy = false;
  #recordsPausedUntil = 0;
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
    if (op.status === 'sent') return this.#checkSent(op);
    // Attempt records wait, untouched, while there is no attempts contract or it does not take our key.
    if (isRecord(op) && (this.chain.attempts === null || this.clock() < this.#recordsPausedUntil)) return;
    // Back off after refused tries: 10 s, 20 s, 40 s... up to five minutes.
    const wait = Math.min(MAX_BACKOFF_MS, 10_000 * 2 ** Math.max(0, op.tries - 1));
    if (op.tries > 0 && this.clock() - op.updatedAt.getTime() < wait) return;
    if (await this.#alreadyDone(op)) return;
    // An attempt's end is written only once its start has landed (or been given up).
    if (op.kind === 'record_end' && (await this.store.opsOf({ attemptId: op.attemptId! }))
      .some((o) => o.kind === 'record_start' && (o.status === 'pending' || o.status === 'sent'))) return;
    if (op.kind === 'resolve') {
      // A winner is paid for as long as the contract allows: only a closed window ends it.
      if (await this.#windowClosed(op)) return this.#fail(op, 'window_closed');
    } else if (op.tries >= MAX_TRIES) return this.#fail(op, op.lastError ?? 'too_many_tries');
    const call = await this.#call(op);
    if (call) await this.#send(op, call);
  }

  async #send(op: ChainOp, call: ChainCall, options?: PrepareOptions): Promise<void> {
    let tx;
    try { tx = await this.chain.prepare(call, options); }
    catch (error) {
      const message = (error as Error).message;
      if (op.kind === 'resolve' && PERMANENT_RESOLVE.test(message)) return this.#fail(op, `prepare: ${message}`);
      if (isRecord(op) && /NotRecorder/.test(message)) {
        if (this.clock() >= this.#recordsPausedUntil) console.error('[challenges] the attempts contract does not take this key as its recorder; records wait');
        this.#recordsPausedUntil = this.clock() + RECORDS_PAUSE_MS;
        return this.store.noteOpError(op.id, `prepare: ${message}`);
      }
      // The contract refused (counts towards giving up refunds and relays), or the RPC failed (does not).
      return this.store.retryOp(op.id, `prepare: ${message}`, isRevert(message));
    }
    await this.store.markOpSent(op.id, tx.hash, tx.nonce, tx.maxFeePerGas);
    // A failed broadcast may still have reached the node: keep the hash and let the receipt check decide.
    try { await this.chain.broadcast(tx.raw); }
    catch (error) { await this.store.noteOpError(op.id, `broadcast: ${(error as Error).message}`); }
  }

  /** What the contract already shows: if the work is done (by us before a restart, or anyone), record it. */
  async #alreadyDone(op: ChainOp): Promise<boolean> {
    if (op.kind === 'relay_create') {
      const draft = await this.store.draft(op.draftId!);
      if (draft?.relayedAt) { await this.store.markOpConfirmed(op.id); return true; }
      return false;
    }
    if (op.kind === 'record_start' || op.kind === 'record_end') {
      const stage = await this.chain.attemptStage(op.attemptId!);
      if (stage >= (op.kind === 'record_start' ? 1 : 2)) { await this.store.markOpConfirmed(op.id); return true; }
      return false;
    }
    const onChain = await this.chain.status(op.challengeId!);
    if (onChain.status === 'resolved') {
      await this.store.setStatus(op.challengeId!, ['open', 'unrecognised', 'unpaid', 'refunding', 'won'], 'paid');
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

  async #windowClosed(op: ChainOp): Promise<boolean> {
    const challenge = await this.store.challenge(op.challengeId!);
    return !challenge || this.clock() > challenge.deadline.getTime() + GRACE_SECONDS * 1000;
  }

  async #call(op: ChainOp): Promise<ChainCall | null> {
    const p = op.payload as Record<string, string>;
    switch (op.kind) {
      case 'resolve': return { fn: 'resolve', id: op.challengeId!, winner: p.winner as Hex, resultHash: p.resultHash as Hex };
      case 'refund': return { fn: 'refund', id: op.challengeId! };
      case 'record_start': return { fn: 'recordStart', attemptId: op.attemptId!, challengeId: op.challengeId!, player: p.player as Hex };
      case 'record_end': return { fn: 'recordEnd', attemptId: op.attemptId!, challengeId: op.challengeId!,
        outcome: Number(p.outcome) as AttemptOutcome, logHash: p.logHash as Hex };
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
      // Someone else may have settled it first; otherwise try again (a payout until its window closes).
      if (await this.#alreadyDone(op)) return;
      if (op.kind !== 'resolve' && op.tries >= MAX_TRIES) return this.#fail(op, 'reverted');
      return this.store.retryOp(op.id, 'reverted', true);
    }
    const age = this.clock() - op.updatedAt.getTime();
    if (!(await this.chain.known(op.txHash!))) {
      // Not even pending: dropped. Only after a while, in case the node is just slow to show it.
      if (age > DROPPED_AFTER_MS) await this.store.retryOp(op.id, 'dropped', false);
      return;
    }
    if (age > STUCK_AFTER_MS && op.sentNonce !== null) {
      // Pending too long at its fee: replace it at the same nonce, 12.5% dearer at least (the
      // usual replacement rule). If the old one is mined meanwhile, the state check above records it.
      if (await this.#alreadyDone(op)) return;
      const call = await this.#call(op);
      if (!call) return;
      const minMaxFeePerGas = BigInt(op.sentMaxFee ?? '0') * 1125n / 1000n + 1n;
      await this.#send(op, call, { nonce: op.sentNonce, minMaxFeePerGas });
    }
  }

  async #fail(op: ChainOp, reason: string): Promise<void> {
    await this.store.markOpFailed(op.id, reason);
    // A winner who cannot be paid (a blocklisted address, a window that closed): the prize refunds.
    if (op.kind === 'resolve') await this.store.setStatus(op.challengeId!, ['won'], 'unpaid');
    console.error(`[challenges] ${op.kind} ${op.id} failed: ${reason}`);
  }
}
