import { describe, expect, it } from 'vitest';
import { MicroEcologyLayer, microMarkerPosition } from '../src/microEcologyLayer.js';
import { patchCentre, waterAccessPosition } from '@vana/shared';
import type { MicroEcologyState } from '@vana/shared';
import type { PatchView } from '../src/terrain.js';
import { ISLAND_GRID } from '@vana/shared';

const patches: PatchView[] = [{ id: 0, x: 0, y: 0, habitat: 'grassland', grass: 100, browse: 10, water: 0 }];
const state: MicroEcologyState = { updatedAt: 3600, patches: [{
  patchId: 0, antColonies: 1, fishSchools: 0, antBiomassKg: 0.02, pollinatorBiomassKg: 0.01,
  detritivoreBiomassKg: 0.01, aquaticProducerBiomassKg: 0, fishBiomassKg: 0,
  lastFishSpawnYear: 0, decomposerBiomassKg: 0.02,
}] };

describe('MicroEcologyLayer', () => {
  it('renders one representative marker per populated role and hides absent state', () => {
    const layer = new MicroEcologyLayer();
    const marker = layer.root.getObjectByName('micro-ecology') as import('three').Points<import('three').BufferGeometry, import('three').PointsMaterial>;
    expect(marker.material.sizeAttenuation).toBe(false);
    expect(marker.material.size).toBeLessThanOrEqual(4);
    const pixels = marker.material.map!.image.data as Uint8Array;
    expect(pixels[3]).toBe(0); // Outside the circular dot is transparent.
    expect(pixels[(8 * 16 + 8) * 4 + 3]).toBe(255);
    layer.sync(state, patches, () => 0);
    expect(layer.root.visible).toBe(true);
    expect(layer.root.getObjectByName('micro-ecology')!.geometry.drawRange.count).toBe(3);
    layer.sync(undefined, patches, () => 0);
    expect(layer.root.visible).toBe(false);
    layer.dispose();
  });

  it('scatters land markers across their patch instead of stacking them on its centre', () => {
    const offsets = new Set<string>();
    for (let id = 0; id < 40; id++) for (const role of ['ants', 'pollinators', 'detritivores']) {
      const centre = patchCentre(ISLAND_GRID, id), at = microMarkerPosition(role, id, true);
      const dx = at.x - centre.x, dz = at.z - centre.z;
      expect(Math.abs(dx)).toBeLessThan(ISLAND_GRID.patchM / 2 - 30);
      expect(Math.abs(dz)).toBeLessThan(ISLAND_GRID.patchM / 2 - 30);
      offsets.add(`${Math.round(dx / 10)},${Math.round(dz / 10)}`);
    }
    // No lattice: the offset from the centre differs from patch to patch and role to role.
    expect(offsets.size).toBeGreaterThan(100);
    expect(microMarkerPosition('ants', 7, true)).toEqual(microMarkerPosition('ants', 7, true));
  });

  it('keeps fish in the pool: at the access point on the island, at the centre on the mainland', () => {
    const pool = waterAccessPosition(ISLAND_GRID, 12), centre = patchCentre(ISLAND_GRID, 12);
    expect(Math.hypot(microMarkerPosition('fish', 12, true).x - pool.x, microMarkerPosition('fish', 12, true).z - pool.z)).toBeLessThan(2);
    expect(Math.hypot(microMarkerPosition('fish', 12, false).x - centre.x, microMarkerPosition('fish', 12, false).z - centre.z)).toBeLessThan(2);
  });
});
