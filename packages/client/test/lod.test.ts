import { describe, expect, it } from 'vitest';
import { chooseVisible } from '../src/lod.js';

const at = (x: number, z: number) => ({ x, z });

describe('chooseVisible', () => {
  // The forest holds thousands of animals. Giving every one a skinned, shadowed, animated model
  // crashed the page the moment the live world grew past its early sixty sambar.
  it('keeps only the nearest animals to where the camera is looking', () => {
    const positions = new Map(Array.from({ length: 5000 }, (_, i) => [`a${i}`, at(i * 10, 0)] as const));
    const visible = chooseVisible(positions, at(0, 0), null, { max: 100, radiusM: 100_000 });
    expect(visible.size).toBe(100);
    expect(visible.has('a0')).toBe(true);
    expect(visible.has('a99')).toBe(true);
    expect(visible.has('a100')).toBe(false);
  });

  it('drops animals beyond the render radius even when there is room', () => {
    const positions = new Map([['near', at(50, 0)], ['far', at(5000, 0)]]);
    expect([...chooseVisible(positions, at(0, 0), null, { max: 100, radiusM: 800 })]).toEqual(['near']);
  });

  it('always keeps the followed animal, wherever it is', () => {
    const positions = new Map([['near', at(50, 0)], ['watched', at(9000, 9000)]]);
    const visible = chooseVisible(positions, at(0, 0), 'watched', { max: 1, radiusM: 800 });
    expect(visible.has('watched')).toBe(true);
    expect(visible.size).toBe(1);
  });
});
