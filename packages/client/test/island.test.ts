import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildGrid } from '@vana/sim';
import { islandHeightAt, ISLAND_SEGMENTS } from '@vana/shared';
import { buildTerrain, makeHeightSampler, countDrawCalls, type PatchView } from '../src/terrain.js';
import { disposeTerrain } from '../src/environment.js';
import { mapTerrainColour } from '../src/eventMap.js';
import { SceneUpdates } from '../src/sceneUpdates.js';
import { planVegetation } from '../src/vegetation.js';

const patches: PatchView[] = buildGrid(1, 'island_v1').map(p => ({ ...p, grass: p.plant.grass, browse: p.plant.browse, water: p.waterVolume }));
describe('shared island presentation', () => {
  it('renders a continuous island and surrounding ocean with a bounded mesh and draw calls', () => {
    const root = buildTerrain(patches), ground = root.getObjectByName('ground') as THREE.Mesh;
    expect(ground.geometry.attributes.position!.count).toBe((ISLAND_SEGMENTS + 1) ** 2);
    expect(ground.geometry.index!.count / 3).toBe(115200);
    expect(countDrawCalls(root)).toBeLessThan(12);
    expect((root.getObjectByName('ocean') as THREE.Mesh).position.y).toBe(0);
    const ray = new THREE.Raycaster(), sampler = makeHeightSampler(patches);
    for (const [x, z] of [[2850, 2850], [500, 2600], [4200, 3800], [0, 0], [5670, 2940]]) {
      ray.set(new THREE.Vector3(x!, 1000, z!), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(ground)[0]!;
      expect(sampler(x!, z!)).toBeCloseTo(hit.point.y, 5);
      expect(sampler(x!, z!)).toBe(islandHeightAt(1, x!, z!));
    }
    disposeTerrain(root);
  });
  it('does not draw freshwater tiles or vegetation on the ocean/coastal mask', () => {
    const ocean = patches.filter(p => p.surface !== 'land'), root = buildTerrain(ocean);
    for (const name of ['water', 'grass', 'trunk', 'canopy', 'rock'])
      expect((root.getObjectByName(name) as THREE.InstancedMesh).count).toBe(0);
    expect(planVegetation(ocean, { x: 2850, z: 2850 }, 10000, () => 0).size).toBe(0);
    disposeTerrain(root);
  });
  it('disposes newly owned island and ocean geometry/materials on scene replacement', () => {
    const root = buildTerrain(patches), ground = root.getObjectByName('ground') as THREE.Mesh, ocean = root.getObjectByName('ocean') as THREE.Mesh;
    const checks = [vi.spyOn(ground.geometry, 'dispose'), vi.spyOn(ocean.geometry, 'dispose'),
      vi.spyOn(ground.material as THREE.Material, 'dispose'), vi.spyOn(ocean.material as THREE.Material, 'dispose')];
    disposeTerrain(root); for (const check of checks) expect(check).toHaveBeenCalledOnce();
  });
  it('maps the coastline from the same height field and does not paint every freshwater litre as a lake', () => {
    expect(mapTerrainColour(patches[0]!, 0, 0)).toBe('#326077');
    expect(mapTerrainColour(patches[190]!, 2850, 2850)).not.toBe('#326077');
    expect(mapTerrainColour({ id: 0, x: 0, y: 0, habitat: 'shola', water: 12, grass: 300, browse: 100, canopyCover: 0.8 }, 0, 0)).toBe('#294b37');
  });
  it('rejects mixed, incomplete or malformed island checkpoint geometry before preparation', () => {
    const prepare = vi.fn(async () => undefined), updates = new SceneUpdates({ prepare, commit: vi.fn(), discard: vi.fn(), status: vi.fn() });
    const scene = (terrain: unknown[]) => ({ type: 'scene', protocol: 1, checkpointId: 'island',
      world: { worldTime: 0, nextEventSequence: 0, population: {}, worldHoursPerRealHour: 12 },
      environment: { patches: terrain, carcasses: [] }, animals: [], frame: null });
    expect(updates.receive(scene(patches.slice(0, 399)), 0)).toBe(false);
    expect(updates.receive(scene(patches.map((p, i) => i === 12 ? { ...p, islandSeed: 2 } : p)), 0)).toBe(false);
    expect(updates.receive(scene(patches.map((p, i) => i === 12 ? { ...p, surface: 'unknown' } : p)), 0)).toBe(false);
    expect(prepare).not.toHaveBeenCalled(); expect(updates.receive(scene(patches), 0)).toBe(true);
  });
});
