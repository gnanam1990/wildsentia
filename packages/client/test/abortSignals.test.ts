import { afterEach, describe, expect, it } from 'vitest';
import { anySignal, withTimeout } from '../src/abortSignals.js';

const native = AbortSignal.any;
/** iOS Safari before 17.4 has no AbortSignal.any. */
function withoutNativeAny(): void { (AbortSignal as unknown as { any?: unknown }).any = undefined; }
afterEach(() => { (AbortSignal as unknown as { any: typeof native }).any = native; });

describe('combined abort signals on browsers without AbortSignal.any', () => {
  it('aborts with the first source to abort, keeping its reason', () => {
    withoutNativeAny();
    const a = new AbortController(), b = new AbortController();
    const combined = anySignal([a.signal, b.signal]);
    expect(combined.aborted).toBe(false);
    b.abort('stopped');
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('stopped');
    a.abort('later');
    expect(combined.reason).toBe('stopped');
  });
  it('is already aborted when a source already was', () => {
    withoutNativeAny();
    const a = new AbortController(); a.abort('gone');
    const combined = anySignal([new AbortController().signal, a.signal]);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('gone');
  });
  it('gives up after the timeout, and still follows the caller', async () => {
    withoutNativeAny();
    const caller = new AbortController();
    const timed = withTimeout(caller.signal, 20);
    expect(timed.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(timed.aborted).toBe(true);
    const second = withTimeout(caller.signal, 10_000);
    caller.abort();
    expect(second.aborted).toBe(true);
  });
  it('uses the native AbortSignal.any where it exists', () => {
    let called = 0;
    (AbortSignal as unknown as { any: typeof native }).any = (signals) => { called++; return native.call(AbortSignal, signals); };
    anySignal([new AbortController().signal]);
    expect(called).toBe(1);
  });
});
