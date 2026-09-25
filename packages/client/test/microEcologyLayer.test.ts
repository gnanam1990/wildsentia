import { describe, expect, it } from 'vitest';
import { MicroEcologyLayer } from '../src/microEcologyLayer.js';
import type { MicroEcologyState } from '@vana/shared';
import type { PatchView } from '../src/terrain.js';

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
});
