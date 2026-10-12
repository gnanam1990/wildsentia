/**
 * WebSocket close code 1013, "Try Again Later": the server is at its connection cap, or has no
 * saved world to show. Matches LIVE_BUSY_CLOSE_CODE in the server's gateway.
 */
export const LIVE_BUSY_CLOSE_CODE = 1013;

/**
 * How long the observer waits before reconnecting to /live. An ordinary drop (a server restart)
 * reconnects within two seconds; each further failure without a scene doubles the wait, up to a
 * minute. A server that says it is full starts at fifteen seconds and goes up to two minutes.
 * Each wait is between half and all of its step, so a crowd turned away together does not
 * come back together.
 */
export class ReconnectBackoff {
  #failures = 0;

  constructor(private readonly random: () => number = Math.random) {}

  /** A scene arrived: the connection works, so the next drop reconnects promptly again. */
  succeeded(): void { this.#failures = 0; }

  /** The wait, in milliseconds, before reconnecting after a close with this code. */
  next(closeCode: number): number {
    const busy = closeCode === LIVE_BUSY_CLOSE_CODE;
    const [base, cap] = busy ? [15_000, 120_000] : [2_000, 60_000];
    const step = Math.min(cap, base * 2 ** Math.min(this.#failures, 10));
    this.#failures++;
    return Math.round(step / 2 + this.random() * step / 2);
  }
}
