/**
 * AbortSignal.any arrived in iOS Safari only with 17.4; without it every history, recap and
 * share request threw before it was sent. These use the native versions where they exist.
 */

/** A signal that aborts as soon as any of `signals` does, with that signal's reason. */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const native = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') return native.call(AbortSignal, [...signals]);
  const controller = new AbortController();
  const already = signals.find((s) => s.aborted);
  if (already) { controller.abort(already.reason); return controller.signal; }
  const stop = (): void => {
    const first = signals.find((s) => s.aborted);
    for (const s of signals) s.removeEventListener('abort', stop);
    controller.abort(first?.reason);
  };
  // Listeners are removed when any source aborts; a timeout source always eventually does.
  for (const s of signals) s.addEventListener('abort', stop, { once: true });
  return controller.signal;
}

/** A signal that aborts after `ms`, also where AbortSignal.timeout is missing. */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), ms);
  return controller.signal;
}

/** The caller's signal, giving up after `ms` as well. */
export const withTimeout = (signal: AbortSignal, ms: number): AbortSignal => anySignal([signal, timeoutSignal(ms)]);
