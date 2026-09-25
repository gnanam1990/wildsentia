import { describe, expect, it } from 'vitest';
import { characterScale, coatMultiplier, markerSize } from '../src/appearance.js';

describe('individual character appearance', () => {
  it('keeps markers proportionate for both a hare and an elephant', () => {
    expect(markerSize(0.22)).toBeLessThan(0.22);
    expect(markerSize(2.7)).toBeLessThan(1);
    expect(markerSize(2.7)).toBeGreaterThan(markerSize(0.22));
  });
  it('renders a newborn smaller and grows continuously with mass', () => {
    expect(characterScale({ sizeRatio: 0.125 })).toBeCloseTo(0.5);
    expect(characterScale({ sizeRatio: 1 })).toBe(1);
    expect(characterScale({ sizeRatio: 0.5 })).toBeLessThan(1);
    expect(characterScale({ sizeRatio: NaN })).toBe(1);
  });
  it('keeps coat variation deterministic and bounded', () => {
    expect(coatMultiplier(0)).toBeCloseTo(0.86);
    expect(coatMultiplier(1)).toBeCloseTo(1.1);
    expect(coatMultiplier(0.3)).toBe(coatMultiplier(0.3));
  });
});
