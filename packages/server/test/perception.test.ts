import { describe, expect, it } from 'vitest';
import { daylightAt, perceive, SENSES, windAt } from '../src/bounties/perception.js';

const noon = 12 * 3600, midnight = 0;
const at = (x: number, z: number, extra: Partial<{ moving: boolean; running: boolean }> = {}) => ({ x, z, moving: false, running: false, ...extra });
const leopard = { x: 0, z: 0, speciesId: 'african_leopard' };

// Congo 1D (spec §6): an animal learns of another only by sensing it; the same rules for every agent.
describe('perception', () => {
  it('sees in the open by day, less under canopy, less again at night', () => {
    const open = { canopy: 0, daylight: daylightAt(noon), windHeading: 0 };
    expect(perceive(leopard, at(0, 140), open)).toBe('sight');
    expect(perceive(leopard, at(0, 140), { ...open, canopy: 0.9 })).toBeNull();
    expect(perceive(leopard, at(0, 50), { ...open, canopy: 0.9 })).toBe('sight');
    expect(perceive(leopard, at(0, 140), { ...open, daylight: daylightAt(midnight) })).toBeNull();
    expect(daylightAt(midnight)).toBe(0); expect(daylightAt(noon)).toBe(1);
  });
  it('smells farther downwind than upwind, and hears only what moves', () => {
    const dark = { canopy: 0.95, daylight: 0 };
    // The wind blows from the target toward the leopard (heading +z → -z is π): the scent reaches it.
    const towardLeopard = Math.PI, awayFromLeopard = 0;
    const target = at(0, SENSES.african_leopard!.smellM * 1.5);
    expect(perceive(leopard, target, { ...dark, windHeading: towardLeopard })).toBe('smell');
    expect(perceive(leopard, target, { ...dark, windHeading: awayFromLeopard })).toBeNull();
    const near = at(0, SENSES.african_leopard!.hearingM * 0.9);
    expect(perceive(leopard, near, { ...dark, windHeading: awayFromLeopard })).toBeNull();
    expect(perceive(leopard, { ...near, moving: true }, { ...dark, windHeading: awayFromLeopard })).toBe('hearing');
  });
  it('blows the same wind for every viewer at a given hour, and turns with the hours', () => {
    expect(windAt('w1', 3600)).toBe(windAt('w1', 3601));
    const headings = new Set(Array.from({ length: 24 }, (_, h) => windAt('w1', h * 3600).toFixed(3)));
    expect(headings.size).toBeGreaterThan(12);
  });
});
