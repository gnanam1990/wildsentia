import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID, patchCount } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { clampToIsland } from '../src/camera.js';
import { toMetres, toPixel } from '../src/challengeNewModel.js';
import { loadLifeHistory } from '../src/lifeHistory.js';
import { makeHeightSampler, type PatchView } from '../src/terrain.js';

// Congo plan 1A review: these read the grid once at import, or hard-coded the island's 20 × 20.
afterEach(() => { setWorldGrid(ISLAND_GRID); vi.unstubAllGlobals(); });

describe('client code on the Congo grid', () => {
  it('lets the camera range over the whole 48 km forest', () => {
    setWorldGrid(CONGO_GRID);
    expect(clampToIsland(new THREE.Vector3(40_000, 0, 40_000)).x).toBe(40_000);
    setWorldGrid(ISLAND_GRID);
    expect(clampToIsland(new THREE.Vector3(40_000, 0, 40_000)).x).toBe(6_150);
  });

  it('maps the challenge picker across the whole world', () => {
    setWorldGrid(CONGO_GRID);
    expect(toMetres(100, 100, 100)).toEqual({ x: 47_850, z: 47_850 });
    expect(toPixel(47_850, -150, 100)).toEqual({ px: 100, py: 0 });
  });

  it('accepts a life track point in a Congo patch beyond the island\'s 400', async () => {
    setWorldGrid(CONGO_GRID);
    const point = { worldTime: 0, patchId: 12_345, state: 'resting', goal: 'rest', drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 0 } };
    const body = { id: 'a', asOfWorldTime: 3600, nextEventSequence: 9, source: 'checkpoint', speciesId: 'leopard', alive: true,
      bornAt: 0, departedAt: null, track: [point], moments: [], encounters: [], nextCursor: null };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    expect((await loadLifeHistory('a', { signal: new AbortController().signal })).track).toEqual([point]);
  });

  it('samples ground height across the whole Congo grid', () => {
    setWorldGrid(CONGO_GRID);
    const patches: PatchView[] = Array.from({ length: patchCount(CONGO_GRID) }, (_, id) => ({
      id, x: id % 160, y: Math.floor(id / 160), habitat: 'terra_firme', grass: 0, browse: 0, elevation: id >= 12_800 ? 1 : 0,
    } as PatchView));
    const sample = makeHeightSampler(patches);
    expect(sample(30_000, 45_000)).toBeGreaterThan(80);
    expect(sample(30_000, 3_000)).toBeLessThan(1);
  });
});
