import { describe, expect, it } from 'vitest';
import { atmosphereAt, observerExposure } from '../src/environment.js';

describe('authoritative clock and seasonal atmosphere', () => {
  it('is dark at midnight and brightest at noon', () => {
    expect(atmosphereAt(0, 'dry').daylight).toBe(0);
    expect(atmosphereAt(12 * 3600, 'dry').daylight).toBe(1);
    expect(atmosphereAt(86400, 'dry')).toEqual(atmosphereAt(0, 'dry'));
  });
  it('uses the reported season rather than random local weather', () => {
    expect(atmosphereAt(0, 'monsoon').rain).toBeGreaterThan(atmosphereAt(0, 'wet').rain);
    expect(atmosphereAt(0, 'dry').rain).toBe(0);
    expect(atmosphereAt(0, 'unknown').rain).toBe(0);
  });
});

describe('observer exposure', () => {
  it('brightens the night for the viewer without touching daylight', () => {
    expect(observerExposure(1)).toBeCloseTo(1.1);
    expect(observerExposure(0)).toBeGreaterThan(1.7);
    expect(observerExposure(0.5)).toBeGreaterThan(observerExposure(1));
    expect(observerExposure(-3)).toBe(observerExposure(0));
  });
});
