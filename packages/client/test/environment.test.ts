import { describe, expect, it } from 'vitest';
import { atmosphereAt } from '../src/environment.js';

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
