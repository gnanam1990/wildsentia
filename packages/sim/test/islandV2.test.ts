import { describe, expect, it } from 'vitest';
import { GRID_SIZE, ISLAND_V2_GEOMETRY_OFFSET, PATCH_METRES, islandGeometrySeed, islandHeightAt, islandPatchSurface,
  isIslandProfile, landWalkable } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { createWorld } from '../src/world.js';
import { ISLAND_POPULATION, ISLAND_V2_POPULATION, islandPopulation } from '../src/forest.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { SPECIES_DIR } from './helpers.js';

const km2 = (PATCH_METRES / 1000) ** 2;
const edge = (id: number) => { const x = id % GRID_SIZE, y = Math.floor(id / GRID_SIZE); return x === 0 || y === 0 || x === GRID_SIZE - 1 || y === GRID_SIZE - 1; };

describe('island_v2: a larger island in the same 20 x 20 grid (sim_0.37.0)', () => {
  it('holds about 26 km² of core land with a sea margin, twice island_v1, which is unchanged', () => {
    for (const seed of [1, 2, 3, 7, 12]) {
      const v2 = buildGrid(seed, 'island_v2'), v1 = buildGrid(seed, 'island_v1');
      const land2 = v2.filter(landWalkable), land1 = v1.filter(landWalkable);
      expect(land2.length * km2).toBeGreaterThan(25);
      expect(land2.length * km2).toBeLessThan(28);
      expect(land1.length * km2).toBeGreaterThan(12);
      expect(land1.length * km2).toBeLessThan(13);
      // The outer ring of patches is sea or shore on every side.
      expect(v2.filter(p => edge(p.id) && landWalkable(p))).toEqual([]);
      // Same habitat noise, same freshwater basins rule: forest, grassland, riverine, marsh and pools.
      for (const habitat of ['shola', 'grassland', 'riparian', 'water'])
        expect(land2.some(p => p.habitat === habitat), `${seed} ${habitat}`).toBe(true);
      expect(land2.filter(p => p.habitat !== 'water' && p.waterVolume > 0).length).toBeGreaterThan(land2.length / 2);
      // island_v1 keys its geometry by the world seed, exactly as before.
      expect(v1.every(p => p.islandSeed === seed)).toBe(true);
      expect(v2.every(p => p.islandSeed === ISLAND_V2_GEOMETRY_OFFSET + seed)).toBe(true);
    }
  });

  it('keys its geometry so every consumer of islandSeed, the renderer included, draws the same island', () => {
    expect(isIslandProfile('island_v2')).toBe(true);
    expect(isIslandProfile('mainland')).toBe(false);
    const key = islandGeometrySeed(2, 'island_v2');
    expect(Number.isSafeInteger(key)).toBe(true);
    const patches = buildGrid(2, 'island_v2');
    for (const p of patches) expect(islandPatchSurface(key, p.id)).toBe(p.surface);
    // A point deep inland on island_v2 is sea on island_v1.
    const corner = { x: 4 * PATCH_METRES, z: 4 * PATCH_METRES };
    expect(islandHeightAt(key, corner.x, corner.z)).toBeGreaterThan(2);
    expect(islandHeightAt(2, corner.x, corner.z)).toBeLessThan(0);
    expect(() => islandGeometrySeed(-1, 'island_v2')).toThrow(/out of range/);
    expect(() => islandGeometrySeed(ISLAND_V2_GEOMETRY_OFFSET, 'island_v1')).toThrow(/out of range/);
  });

  it('is founded at the same prey densities with field-density predators: three tigers, four leopards, a pack of six', () => {
    expect(islandPopulation('island_v1')).toBe(ISLAND_POPULATION);
    expect(ISLAND_V2_POPULATION).toMatchObject({ tiger: 3, leopard: 4, dhole: 6, jackal: 29, chital: 1008, sambar: 324, boar: 360 });
    for (const id of ['chital', 'sambar', 'gaur', 'boar', 'hare', 'langur', 'squirrel'])
      expect(ISLAND_V2_POPULATION[id]! / ISLAND_POPULATION[id]!).toBeCloseTo(0.72 / 0.34, 0);
    const world = createWorld({ seed: 1, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2',
      initialAgents: { tiger: 3, leopard: 4 }, minPopulation: {} });
    for (const species of ['tiger', 'leopard']) {
      const cats = world.agents.filter(a => a.speciesId === species);
      expect(cats.map(a => a.sex)).toEqual(species === 'tiger' ? ['male', 'female', 'female'] : ['male', 'female', 'female', 'female']);
      expect(cats.every(a => landWalkable(world.patches[a.patchId]))).toBe(true);
    }
  });

  it('checkpoints and restores, and never boots as the other island', () => {
    const options = { seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2' as const, initialAgents: { chital: 5 }, minPopulation: {} };
    const world = createWorld(options);
    world.step(2);
    const snapshot = takeSnapshot(world);
    expect(snapshot.terrainProfile).toBe('island_v2');
    expect(restoreSnapshot(structuredClone(snapshot), options).agents).toEqual(world.agents);
    expect(() => restoreSnapshot(structuredClone(snapshot), { ...options, terrainProfile: 'island_v1' })).toThrow(/terrain profile mismatch/);
    const forged = structuredClone(snapshot); forged.patches[0]!.islandSeed = 3;
    expect(() => restoreSnapshot(forged, options)).toThrow(/geometry/);
  });
});
