import { describe, expect, it } from 'vitest';
import { atRecordedWaterAccess, atWaterAccess, isDrinkingActivity, legacyWaterAccessPosition, patchCentre,
  PATCH_COUNT, PATCH_METRES, positionInPatch, waterAccessPosition } from '../src/index.js';

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
});
