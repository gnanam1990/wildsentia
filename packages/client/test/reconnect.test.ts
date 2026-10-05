import { describe, expect, it } from 'vitest';
import { LIVE_BUSY_CLOSE_CODE, ReconnectBackoff } from '../src/reconnect.js';

describe('observer /live reconnection', () => {
  it('reconnects promptly after an ordinary drop, then backs off while attempts keep failing', () => {
    const backoff = new ReconnectBackoff(() => 1); // The top of each jitter range.
    const delays = Array.from({ length: 8 }, () => backoff.next(1006));
    expect(delays[0]).toBeLessThanOrEqual(2_000);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(delays.at(-1)).toBe(60_000);
  });

  it('waits much longer when the server says it is full, and spreads viewers out with jitter', () => {
    const low = new ReconnectBackoff(() => 0), high = new ReconnectBackoff(() => 1);
    const first = [low.next(LIVE_BUSY_CLOSE_CODE), high.next(LIVE_BUSY_CLOSE_CODE)];
    expect(first[0]).toBeGreaterThanOrEqual(7_500);
    expect(first[1]).toBeGreaterThan(first[0]!);
    // A full server never brings back a two-second hammer, however many times it refuses.
    const busy = new ReconnectBackoff(() => 0);
    for (let i = 0; i < 50; i++) expect(busy.next(LIVE_BUSY_CLOSE_CODE)).toBeGreaterThanOrEqual(7_500);
    expect(busy.next(LIVE_BUSY_CLOSE_CODE)).toBeLessThanOrEqual(120_000);
  });

  it('starts over once a scene has arrived', () => {
    const backoff = new ReconnectBackoff(() => 1);
    for (let i = 0; i < 6; i++) backoff.next(1006);
    backoff.succeeded();
    expect(backoff.next(1006)).toBeLessThanOrEqual(2_000);
  });
});
