import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng.js';

describe('createRng', () => {
  it('is deterministic for the same seed and label', () => {
    const a = createRng(42, 'hunt');
    const b = createRng(42, 'hunt');
    expect(Array.from({ length: 10 }, () => a.next())).toEqual(Array.from({ length: 10 }, () => b.next()));
  });

  it('produces different streams for different labels', () => {
    expect(createRng(42, 'hunt').next()).not.toEqual(createRng(42, 'weather').next());
  });

  it('stays inside [0, 1)', () => {
    const r = createRng(7, 'x');
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('forks into an independent but deterministic stream', () => {
    expect(createRng(1, 'p').fork('child').next()).toEqual(createRng(1, 'p').fork('child').next());
  });

  it('round-trips its state so a restored stream continues identically', () => {
    const a = createRng(5, 's');
    for (let i = 0; i < 50; i++) a.next();
    const state = a.exportState();

    const b = createRng(999, 'different');
    b.importState(state);

    expect(Array.from({ length: 20 }, () => b.next())).toEqual(Array.from({ length: 20 }, () => a.next()));
  });

  it('exports four unsigned 32-bit words', () => {
    const state = createRng(5, 's').exportState();
    expect(state).toHaveLength(4);
    for (const word of state) {
      expect(Number.isInteger(word)).toBe(true);
      expect(word).toBeGreaterThanOrEqual(0);
      expect(word).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
