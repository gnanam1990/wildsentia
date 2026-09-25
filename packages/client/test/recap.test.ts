import { describe, expect, it } from 'vitest';
import { LastSeen, worthRecapping } from '../src/recap.js';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
};

describe('LastSeen', () => {
  it('remembers an exact event cursor while reading older time-only browser state', () => {
    const storage = memoryStorage(), seen = new LastSeen(storage);
    storage.setItem('vana.lastSeen.tiger', '7200');
    expect(seen.cursor('tiger')).toEqual({ worldTime: 7200, nextSequence: null });
    seen.mark('tiger', 7200, 42);
    expect(seen.get('tiger')).toBe(7200);
    expect(seen.cursor('tiger')).toEqual({ worldTime: 7200, nextSequence: 42 });
    const again = new LastSeen(storage); expect(again.cursor('tiger')).toEqual(seen.cursor('tiger'));
    seen.mark('tiger', 7200, NaN); expect(seen.cursor('tiger')!.nextSequence).toBe(42);
    for (const value of ['null', '{}', '"hello"', '{"version":1,"worldTime":10,"nextSequence":-1}', '1.5', 'NaN']) {
      storage.setItem('vana.lastSeen.bad', value); expect(seen.cursor('bad')).toBeNull();
    }
  });
  it('remembers when each animal was last watched', () => {
    const seen = new LastSeen(memoryStorage());
    expect(seen.get('tiger_01')).toBeNull();
    seen.mark('tiger_01', 7200);
    expect(seen.get('tiger_01')).toBe(7200);
  });

  it('carries on without memory when storage is unavailable', () => {
    // A private window, or blocked site data. The page must still work; it just cannot recap.
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const seen = new LastSeen(broken);
    expect(() => seen.mark('tiger_01', 7200)).not.toThrow();
    expect(seen.get('tiger_01')).toBeNull();
  });
});

describe('worthRecapping', () => {
  it('recaps only after a real absence', () => {
    expect(worthRecapping(null, 100_000)).toBe(false);
    expect(worthRecapping(99_000, 100_000)).toBe(false);
    expect(worthRecapping(0, 100_000)).toBe(true);
  });
});
