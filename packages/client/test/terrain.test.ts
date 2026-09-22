import { describe, expect, it } from 'vitest';
import { buildTerrain, countDrawCalls, type PatchView } from '../src/terrain.js';

const patches: PatchView[] = Array.from({ length: 400 }, (_, id) => ({
  id, x: id % 20, y: Math.floor(id / 20),
  habitat: ['grassland', 'shola', 'riparian', 'rock', 'marsh', 'water'][id % 6]!,
  grass: 4000, browse: 2000, water: id % 6 === 5 ? 50_000 : 200,
}));

describe('buildTerrain', () => {
  it('renders 400 patches inside the draw-call budget', () => {
    expect(countDrawCalls(buildTerrain(patches))).toBeLessThan(150);
  });

  it('uses instancing rather than one mesh per patch', () => {
    const terrain = buildTerrain(patches);
    let instanced = 0;
    terrain.traverse((o) => {
      if ((o as { isInstancedMesh?: boolean }).isInstancedMesh === true) instanced++;
    });
    expect(instanced).toBeGreaterThan(0);
  });

  it('handles an empty patch list without throwing', () => {
    expect(() => buildTerrain([])).not.toThrow();
  });

  it('is deterministic for the same patches', () => {
    expect(countDrawCalls(buildTerrain(patches))).toBe(countDrawCalls(buildTerrain(patches)));
  });

  it('places water only where the server reported it', () => {
    const dry: PatchView[] = patches.map((p) => ({ ...p, habitat: 'grassland', water: 0 }));
    const terrain = buildTerrain(dry);
    let waterInstances = 0;
    terrain.traverse((o) => {
      if (o.name === 'water') waterInstances = (o as { count?: number }).count ?? 0;
    });
    expect(waterInstances).toBe(0);
  });
});
