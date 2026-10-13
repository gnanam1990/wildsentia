import { describe, expect, it, vi } from 'vitest';
import { CONGO_GRID, ISLAND_GRID } from '@vana/shared';
import { SceneUpdates, type SceneUpdate } from '../src/sceneUpdates.js';
import { setWorldGrid, worldGrid } from '../src/worldGrid.js';

// Congo 1A.4: a region scene of the Congo forest is accepted, with its regions and patch fields.
const congoPatch = (id: number, habitat = 'terra_firme', extra: Record<string, unknown> = {}) => ({
  id, x: id % 160, y: Math.floor(id / 160), habitat, elevation: 0.4, canopyCover: 0.9, congoSeed: 7, surface: 'land',
  grass: 400, browse: 4000, water: 300, ...extra });
const scene = (patches: unknown[]) => ({ type: 'scene', protocol: 1, checkpointId: 'c1', regions: ['r4_4'],
  world: { worldTime: 3600, nextEventSequence: 9, season: 'monsoon', formatted: 'x', population: { blue_duiker: 1 },
    worldHoursPerRealHour: 12, grid: { cols: 160, rows: 160, patchM: 300, regionPatches: 20 } },
  animals: [{ id: 'blue_duiker_0001', speciesId: 'blue_duiker', patchId: 12_880, state: 'resting', currentGoal: 'rest',
    drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 0 } }],
  environment: { patches, carcasses: [] }, frame: null });

describe('a Congo region scene in the browser', () => {
  it('is accepted, with its regions, grid and Congo patch fields', async () => {
    let got: SceneUpdate | null = null;
    const updates = new SceneUpdates<null>({ async prepare() { return null; }, commit(u) { got = u; }, discard() {}, status: vi.fn() });
    const patches = [congoPatch(12_880), congoPatch(12_881, 'flooded_forest', { flooded: true }), congoPatch(12_882, 'water', { deepWater: true, water: 2_000_000 })];
    expect(updates.receive(scene(patches), 0)).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(worldGrid()).toEqual(CONGO_GRID);
    expect(got!.regions).toEqual(['r4_4']);
    expect(got!.environment.patches.map((p) => [p.congoSeed, p.flooded ?? false, p.deepWater ?? false])).toEqual([[7, false, false], [7, true, false], [7, false, true]]);
    setWorldGrid(ISLAND_GRID);
  });
  it('refuses a Congo patch that claims a sea surface, or mixes Congo and island seeds', () => {
    const updates = new SceneUpdates<null>({ async prepare() { return null; }, commit() {}, discard() {}, status: vi.fn() });
    expect(updates.receive(scene([congoPatch(0, 'terra_firme', { surface: 'ocean' })]), 0)).toBe(false);
    expect(updates.receive(scene([congoPatch(0), congoPatch(1, 'terra_firme', { congoSeed: undefined, islandSeed: 3 })]), 0)).toBe(false);
    setWorldGrid(ISLAND_GRID);
  });
  it('prepares the ground again when the regions change within one checkpoint', async () => {
    const prepared: number[][] = [];
    const updates = new SceneUpdates<number[]>({
      async prepare(env) { const ids = env.patches.map((p) => p.id); prepared.push(ids); return ids; },
      commit() {}, discard() {}, status: vi.fn() });
    const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    expect(updates.receive(scene([congoPatch(12_880)]), 0)).toBe(true);
    await settle();
    // The viewer moved: the same checkpoint, now region r3_3 and its patches.
    expect(updates.receive({ ...scene([congoPatch(9_660)]), regions: ['r3_3'] }, 1)).toBe(true);
    await settle();
    expect(prepared).toEqual([[12_880], [9_660]]);
    setWorldGrid(ISLAND_GRID);
  });
});
