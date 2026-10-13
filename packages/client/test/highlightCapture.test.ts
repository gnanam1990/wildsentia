import { describe, expect, it } from 'vitest';
import { highlightStart } from '../src/highlightCapture.js';
describe('recorded highlight window', () => {
  it('selects the actual final twenty seconds and preserves short recordings', () => {
    expect(highlightStart(100000, 20)).toBe(.8);
    expect(highlightStart(10000, 20)).toBe(0);
    expect(highlightStart(30000, 30)).toBe(0);
  });
  it('rejects invalid durations instead of inventing or stretching footage', () => {
    for (const duration of [NaN, Infinity, 0, -1]) expect(() => highlightStart(duration, 20)).toThrow();
    expect(() => highlightStart(100000, 200)).toThrow();
  });
});
