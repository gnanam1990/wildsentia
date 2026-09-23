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
