import { describe, expect, it } from 'vitest';
import { ISLAND_SEGMENTS, ISLAND_STEP_M, islandHeightAt, islandVertexHeight } from '@vana/shared';
import { islandHeightField } from '../src/islandHeightField.js';
import { makeHeightSampler, type PatchView } from '../src/terrain.js';
import { ISLAND_GRID } from '@vana/shared';

describe('exact client island height field', () => {
  it('stores every authoritative vertex exactly and samples both triangles, edges and diagonals in every cell', () => {
    for (const seed of [1, 2, -1234]) {
      const field = islandHeightField(seed);
      expect(field.byteLength).toBe((ISLAND_SEGMENTS + 1) ** 2 * 4);
      for (let row = 0; row <= ISLAND_SEGMENTS; row++) for (let col = 0; col <= ISLAND_SEGMENTS; col++) {
        expect(field.vertex(col, row)).toBe(islandVertexHeight(seed, col, row));
        if (row === ISLAND_SEGMENTS || col === ISLAND_SEGMENTS) continue;
        for (const [fx, fz] of [[0, 0], [.2, .3], [.8, .7], [.25, .75], [1, .5]]) {
          const x = (col + fx!) * ISLAND_STEP_M - ISLAND_GRID.patchM / 2;
          const z = (row + fz!) * ISLAND_STEP_M - ISLAND_GRID.patchM / 2;
          expect(field.sample(x, z)).toBe(islandHeightAt(seed, x, z));
        }
      }
    }
  });

  it('preserves arbitrary-coordinate interpolation, exterior clamping and non-finite behaviour', () => {
    const field = islandHeightField(37); let state = 123;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    for (let i = 0; i < 30_000; i++) {
      const x = -1000 + random() * 8000, z = -1000 + random() * 8000;
      expect(field.sample(x, z)).toBe(islandHeightAt(37, x, z));
    }
    for (const x of [-Infinity, -150, 0, 5850, Infinity, NaN]) for (const z of [-Infinity, 0, 5850, Infinity, NaN])
      expect(field.sample(x, z)).toBe(islandHeightAt(37, x, z));
    expect(() => field.vertex(-1, 0)).toThrow(RangeError);
    expect(() => field.vertex(0, 241)).toThrow(RangeError);
    expect(() => field.vertex(.5, 0)).toThrow(RangeError);
  });

  it('retains only the latest seed entry while old scene samplers remain correct and immutable', () => {
    const first = islandHeightField(1), sample = first.sample;
    expect(islandHeightField(1)).toBe(first); expect(Object.isFrozen(first)).toBe(true);
    const second = islandHeightField(2);
    expect(second).not.toBe(first);
    expect(sample(3333.2, 4444.8)).toBe(islandHeightAt(1, 3333.2, 4444.8));
    expect(second.sample(3333.2, 4444.8)).toBe(islandHeightAt(2, 3333.2, 4444.8));
    expect(islandHeightField(1)).not.toBe(first); // not an unbounded Map of past seeds
  });

  it('wires the terrain sampler to the field without tying existing consumers to mutable patch data', () => {
    const patch: PatchView = { id: 0, x: 0, y: 0, habitat: 'shola', grass: 0, browse: 0, water: 0, islandSeed: 1 };
    const sample = makeHeightSampler([patch]); expect(sample).toBe(islandHeightField(1).sample);
    patch.islandSeed = 2;
    expect(sample(50, 2400)).toBe(islandHeightAt(1, 50, 2400));
    expect(makeHeightSampler([patch])(50, 2400)).toBe(islandHeightAt(2, 50, 2400));
  });
});
