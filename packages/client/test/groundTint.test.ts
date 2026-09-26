import { describe, expect, it } from 'vitest';
import { GroundTint, patchGroundColours } from '../src/groundTint.js';
import { skyColours } from '../src/sky.js';

const patch = (habitat: string, grass: number, canopyCover?: number) => ({ id: 0, habitat, grass, ...(canopyCover === undefined ? {} : { canopyCover }) });
const greenness = (c: { r: number; g: number; b: number }) => c.g - (c.r + c.b) / 2;

describe('ground colour from the checkpoint', () => {
  it('is green where monsoon grass is thick, and gold or bare where it is dry or grazed', () => {
    const lush = patchGroundColours(patch('grassland', 6000), 'monsoon').far;
    const dry = patchGroundColours(patch('grassland', 6000), 'dry').far;
    const grazed = patchGroundColours(patch('grassland', 300), 'monsoon').far;
    expect(greenness(lush)).toBeGreaterThan(greenness(dry));
    expect(greenness(lush)).toBeGreaterThan(greenness(grazed));
    expect(dry.r).toBeGreaterThan(dry.b);
  });
  it('reads dense canopy as dark forest from afar, and keeps rock, water and sea distinct', () => {
    const forest = patchGroundColours(patch('shola', 700, 0.85), 'monsoon').far;
    const open = patchGroundColours(patch('grassland', 6000, 0.1), 'monsoon').far;
    expect(forest.g).toBeLessThan(open.g);
    expect(greenness(forest)).toBeGreaterThan(0);
    const rock = patchGroundColours(patch('rock', 0), 'monsoon').far;
    expect(Math.abs(rock.r - rock.g)).toBeLessThan(0.05);
    expect(patchGroundColours({ ...patch('grassland', 6000), surface: 'ocean' as const }, 'monsoon').far.b)
      .toBeGreaterThan(patchGroundColours({ ...patch('grassland', 6000), surface: 'ocean' as const }, 'monsoon').far.r);
  });
  it('updates its textures only when something visible changed', () => {
    const tint = new GroundTint(2);
    const patches = [{ id: 0, habitat: 'grassland', grass: 6000 }, { id: 3, habitat: 'shola', grass: 700, canopyCover: 0.9 }];
    expect(tint.update(patches, 'monsoon')).toBe(true);
    expect(tint.update(patches, 'monsoon')).toBe(false);
    expect(tint.update([{ ...patches[0]!, grass: 6010 }, patches[1]!], 'monsoon')).toBe(false);
    expect(tint.update(patches, 'dry')).toBe(true);
    const far = tint.far.image.data as Uint8Array;
    expect(far[3 * 4 + 1]).toBeLessThan(far[0 * 4 + 1]!);
  });
});

describe('sky colours', () => {
  it('is dark at night, blue by day, warm near sunrise and greyer in the rains', () => {
    const night = skyColours(0, 0), day = skyColours(1, 0), dawn = skyColours(0.1, 0), rainy = skyColours(1, 0.8);
    expect(night.zenith.b).toBeLessThan(day.zenith.b);
    expect(day.zenith.b).toBeGreaterThan(day.zenith.r);
    expect(dawn.horizon.r).toBeGreaterThan(day.horizon.r);
    expect(Math.abs(rainy.zenith.r - rainy.zenith.b)).toBeLessThan(Math.abs(day.zenith.r - day.zenith.b));
  });
});
