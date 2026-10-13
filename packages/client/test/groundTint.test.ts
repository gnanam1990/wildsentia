import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bakeStandTexture, groundLayers, GroundTint, patchGroundColours } from '../src/groundTint.js';
import { standDensity } from '../src/forestStructure.js';
import { skyColours } from '../src/sky.js';
import { CONGO_GRID, ISLAND_GRID } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';

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

describe('forest floor layers from the checkpoint', () => {
  const forest = { id: 0, habitat: 'shola', grass: 700, canopyCover: 0.85 };
  it('lays heavier leaf litter under canopy after the dry-season fall', () => {
    expect(groundLayers(forest, 'dry').litter).toBeGreaterThan(groundLayers(forest, 'monsoon').litter);
    expect(groundLayers(forest, 'monsoon').litter).toBeGreaterThan(groundLayers({ ...forest, canopyCover: 0.1 }, 'monsoon').litter);
    expect(groundLayers(patch('grassland', 6000, 0), 'dry').litter).toBe(0);
  });
  it('shows bare soil where grass is grazed or dried off, not under a lush sward', () => {
    expect(groundLayers(patch('grassland', 300, 0.05), 'dry').bare).toBeGreaterThan(0.6);
    expect(groundLayers(patch('grassland', 6000, 0.05), 'monsoon').bare).toBe(0);
    expect(groundLayers(patch('grassland', 300, 0.05), 'dry').bare)
      .toBeGreaterThan(groundLayers(patch('grassland', 300, 0.05), 'monsoon').bare);
  });
  it('turns damp and mossy with water, flow and the wet season', () => {
    const dryBank = groundLayers({ ...patch('grassland', 4000, 0.1) }, 'monsoon').moss;
    expect(groundLayers({ ...patch('grassland', 4000, 0.1), water: 60_000 }, 'monsoon').moss).toBeGreaterThan(dryBank + 0.4);
    expect(groundLayers({ ...patch('grassland', 4000, 0.1), drainage: { outflowL: 3_000 } }, 'monsoon').moss).toBeGreaterThan(dryBank + 0.4);
    expect(groundLayers(patch('riparian', 4000, 0.5), 'monsoon').moss).toBeGreaterThan(groundLayers(patch('riparian', 4000, 0.5), 'dry').moss);
    for (const none of [{ ...forest, surface: 'ocean' as const }, patch('water', 0)]) {
      expect(groundLayers(none, 'monsoon')).toEqual({ litter: 0, bare: 0, moss: 0 });
    }
  });
  it('writes the shares to a per-patch texture and spreads them with the trees\u2019 stand pattern', () => {
    const tint = new GroundTint(2);
    tint.update([{ ...forest, id: 1 }], 'dry');
    const layers = tint.layers.image.data as Uint8Array;
    expect(layers[4]).toBe(Math.round(groundLayers(forest, 'dry').litter * 255));
    // A season change alone re-lays the floor.
    expect(tint.update([{ ...forest, id: 1 }], 'monsoon')).toBe(true);
    expect(layers[4]).toBe(Math.round(groundLayers(forest, 'monsoon').litter * 255));
    const stand = bakeStandTexture(64);
    expect(stand.format).toBe(THREE.RedFormat);
    const data = stand.image.data as Uint8Array;
    const span = 6000, at = (col: number, row: number) => standDensity((col + 0.5) / 64 * span - 150, (row + 0.5) / 64 * span - 150);
    expect(data[10 * 64 + 20]).toBe(Math.round(at(20, 10) * 255));
    const material = new THREE.MeshStandardMaterial();
    tint.apply(material);
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '#include <worldpos_vertex>',
      fragmentShader: '#include <color_fragment>' };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.groundLayers!.value).toBe(tint.layers);
    expect(shader.uniforms.groundStand!.value).toBe(tint.stand);
    expect(shader.fragmentShader).toContain('float litter = floorShare.r');
    stand.dispose(); material.dispose();
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

describe('ground colour on the Congo lattice (1A.4)', () => {
  it('tints Congo patches, growing its textures to the 160-patch lattice, and compiles a program per world span', () => {
    const tint = new GroundTint();
    const island = new THREE.MeshStandardMaterial(); tint.apply(island);
    setWorldGrid(CONGO_GRID);
    try {
      const id = 94 * 160 + 96;
      expect(tint.update([{ id, habitat: 'terra_firme', grass: 400, canopyCover: 0.9 }], 'monsoon')).toBe(true);
      expect(tint.near.image.width).toBe(160);
      const texel = Array.from((tint.near.image.data as Uint8Array).slice(id * 4, id * 4 + 3));
      expect(texel).not.toEqual([255, 255, 255]);
      const congo = new THREE.MeshStandardMaterial(); tint.apply(congo);
      expect(congo.customProgramCacheKey()).not.toBe(island.customProgramCacheKey());
    } finally { setWorldGrid(ISLAND_GRID); }
  });
});
