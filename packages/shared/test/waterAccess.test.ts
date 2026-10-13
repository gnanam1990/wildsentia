import { describe, expect, it } from 'vitest';
import { atRecordedWaterAccess, atWaterAccess, isDrinkingActivity, legacyWaterAccessPosition, patchCentre, positionInPatch, waterAccessPosition, waterContactPosition, type HabitatType } from '../src/index.js';
import { ISLAND_GRID, patchCount } from '../src/grid.js';

describe('water access points', () => {
  it('sit off the patch centre, well inside the patch, the same every time', () => {
    const offsets = new Set<string>();
    for (let id = 0; id < patchCount(ISLAND_GRID); id++) {
      const access = waterAccessPosition(ISLAND_GRID, id), centre = patchCentre(ISLAND_GRID, id);
      const r = Math.hypot(access.x - centre.x, access.z - centre.z);
      expect(r).toBeGreaterThanOrEqual(30); expect(r).toBeLessThanOrEqual(95.001);
      expect(positionInPatch(ISLAND_GRID, access, id)).toBe(true);
      expect(Math.abs(access.x - centre.x)).toBeLessThanOrEqual(ISLAND_GRID.patchM / 2 - 55);
      expect(waterAccessPosition(ISLAND_GRID, id)).toEqual(access);
      offsets.add(`${Math.round(access.x - centre.x)},${Math.round(access.z - centre.z)}`);
    }
    // Not one repeated offset: that would still read as a lattice from above.
    expect(offsets.size).toBeGreaterThan(patchCount(ISLAND_GRID) * 0.9);
  });
  it('still accepts drinking recorded at the old centre, but only for history', () => {
    const legacy = legacyWaterAccessPosition(ISLAND_GRID, 210);
    expect(atWaterAccess(ISLAND_GRID, legacy, 210)).toBe(false);
    expect(atRecordedWaterAccess(ISLAND_GRID, legacy, 210)).toBe(true);
    const activity = { type: 'drinking', eventId: 'drink', startSeconds: 0, endSeconds: 60, litres: 1 };
    expect(isDrinkingActivity(ISLAND_GRID, { ...activity, position: legacy })).toBe(true);
    expect(isDrinkingActivity(ISLAND_GRID, { ...activity, position: waterAccessPosition(ISLAND_GRID, 210) })).toBe(true);
    expect(isDrinkingActivity(ISLAND_GRID, { ...activity, position: { ...legacy, x: legacy.x + 20 } })).toBe(false);
  });

  it('puts a lake\'s access point on its shore with dry land, not out in the lake', () => {
    // A patch whose habitat is water is open water from edge to edge. A drinker at the
    // interior point stood 30-95 m out in it (chital_01d9 in island_v2 patch 367).
    const lake = 10 * ISLAND_GRID.cols + 10;
    const ground = Array.from({ length: patchCount(ISLAND_GRID) }, (_, id): { habitat: HabitatType; surface: 'land' } =>
      ({ habitat: id === lake || id === lake - 1 || id === lake - ISLAND_GRID.cols ? 'water' : 'grassland', surface: 'land' }));
    const centre = patchCentre(ISLAND_GRID, lake);
    for (const where of [waterAccessPosition(ISLAND_GRID, lake, ground), waterContactPosition(ISLAND_GRID, 'chital_01d9', lake, ground),
      waterContactPosition(ISLAND_GRID, 'sambar_0001', lake, ground)]) {
      expect(positionInPatch(ISLAND_GRID, where, lake)).toBe(true);
      // Within a few metres of the edge shared with dry land: the east or south side.
      const east = centre.x + ISLAND_GRID.patchM / 2 - where.x, south = centre.z + ISLAND_GRID.patchM / 2 - where.z;
      expect(Math.min(east, south)).toBeLessThan(5);
    }
    expect(waterAccessPosition(ISLAND_GRID, lake, ground)).toEqual(waterAccessPosition(ISLAND_GRID, lake, ground));
    expect(atWaterAccess(ISLAND_GRID, waterContactPosition(ISLAND_GRID, 'chital_01d9', lake, ground), lake, ground)).toBe(true);
    // Dry patches keep their interior point; without the ground the old point is returned.
    expect(waterAccessPosition(ISLAND_GRID, lake + 1, ground)).toEqual(waterAccessPosition(ISLAND_GRID, lake + 1));
    // A recording at the shore validates without knowing the ground, and so does an older one.
    const activity = { type: 'drinking', eventId: 'drink', startSeconds: 0, endSeconds: 60, litres: 1 };
    expect(isDrinkingActivity(ISLAND_GRID, { ...activity, position: waterContactPosition(ISLAND_GRID, 'chital_01d9', lake, ground) })).toBe(true);
    expect(isDrinkingActivity(ISLAND_GRID, { ...activity, position: waterAccessPosition(ISLAND_GRID, lake) })).toBe(true);
  });
});
