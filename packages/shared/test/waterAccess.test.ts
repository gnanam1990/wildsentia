import { describe, expect, it } from 'vitest';
import { atRecordedWaterAccess, atWaterAccess, isDrinkingActivity, legacyWaterAccessPosition, patchCentre,
  GRID_SIZE, PATCH_COUNT, PATCH_METRES, positionInPatch, waterAccessPosition, waterContactPosition,
  type HabitatType } from '../src/index.js';

describe('water access points', () => {
  it('sit off the patch centre, well inside the patch, the same every time', () => {
    const offsets = new Set<string>();
    for (let id = 0; id < PATCH_COUNT; id++) {
      const access = waterAccessPosition(id), centre = patchCentre(id);
      const r = Math.hypot(access.x - centre.x, access.z - centre.z);
      expect(r).toBeGreaterThanOrEqual(30); expect(r).toBeLessThanOrEqual(95.001);
      expect(positionInPatch(access, id)).toBe(true);
      expect(Math.abs(access.x - centre.x)).toBeLessThanOrEqual(PATCH_METRES / 2 - 55);
      expect(waterAccessPosition(id)).toEqual(access);
      offsets.add(`${Math.round(access.x - centre.x)},${Math.round(access.z - centre.z)}`);
    }
    // Not one repeated offset: that would still read as a lattice from above.
    expect(offsets.size).toBeGreaterThan(PATCH_COUNT * 0.9);
  });
  it('still accepts drinking recorded at the old centre, but only for history', () => {
    const legacy = legacyWaterAccessPosition(210);
    expect(atWaterAccess(legacy, 210)).toBe(false);
    expect(atRecordedWaterAccess(legacy, 210)).toBe(true);
    const activity = { type: 'drinking', eventId: 'drink', startSeconds: 0, endSeconds: 60, litres: 1 };
    expect(isDrinkingActivity({ ...activity, position: legacy })).toBe(true);
    expect(isDrinkingActivity({ ...activity, position: waterAccessPosition(210) })).toBe(true);
    expect(isDrinkingActivity({ ...activity, position: { ...legacy, x: legacy.x + 20 } })).toBe(false);
  });

  it('puts a lake\'s access point on its shore with dry land, not out in the lake', () => {
    // A patch whose habitat is water is open water from edge to edge. A drinker at the
    // interior point stood 30-95 m out in it (chital_01d9 in island_v2 patch 367).
    const lake = 10 * GRID_SIZE + 10;
    const ground = Array.from({ length: PATCH_COUNT }, (_, id): { habitat: HabitatType; surface: 'land' } =>
      ({ habitat: id === lake || id === lake - 1 || id === lake - GRID_SIZE ? 'water' : 'grassland', surface: 'land' }));
    const centre = patchCentre(lake);
    for (const where of [waterAccessPosition(lake, ground), waterContactPosition('chital_01d9', lake, ground),
      waterContactPosition('sambar_0001', lake, ground)]) {
      expect(positionInPatch(where, lake)).toBe(true);
      // Within a few metres of the edge shared with dry land: the east or south side.
      const east = centre.x + PATCH_METRES / 2 - where.x, south = centre.z + PATCH_METRES / 2 - where.z;
      expect(Math.min(east, south)).toBeLessThan(5);
    }
    expect(waterAccessPosition(lake, ground)).toEqual(waterAccessPosition(lake, ground));
    expect(atWaterAccess(waterContactPosition('chital_01d9', lake, ground), lake, ground)).toBe(true);
    // Dry patches keep their interior point; without the ground the old point is returned.
    expect(waterAccessPosition(lake + 1, ground)).toEqual(waterAccessPosition(lake + 1));
    // A recording at the shore validates without knowing the ground, and so does an older one.
    const activity = { type: 'drinking', eventId: 'drink', startSeconds: 0, endSeconds: 60, litres: 1 };
    expect(isDrinkingActivity({ ...activity, position: waterContactPosition('chital_01d9', lake, ground) })).toBe(true);
    expect(isDrinkingActivity({ ...activity, position: waterAccessPosition(lake) })).toBe(true);
  });
});
