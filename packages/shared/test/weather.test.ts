import { describe, expect, it } from 'vitest';
import { SHOWER_SHARE, showerIntensity } from '../src/weather.js';

describe('showers', () => {
  it("rains for about the season's share of the time, in several showers a day", () => {
    for (const [season, share] of Object.entries(SHOWER_SHARE)) {
      let rainy = 0, n = 0, showers = 0, before = false;
      for (let t = 0; t < 120 * 86400; t += 600) {
        const now = showerIntensity(t, season) > 0;
        if (now) rainy++; if (now && !before) showers++; before = now; n++;
      }
      expect(Math.abs(rainy / n - share)).toBeLessThan(0.05);
      if (season === 'monsoon') expect(showers / 120).toBeGreaterThan(2);
    }
  });
  it('is the same for everyone at the same moment, bounded, and dry when the season is unknown', () => {
    expect(showerIntensity(86_400 * 7 + 1234, 'monsoon')).toBe(showerIntensity(86_400 * 7 + 1234, 'monsoon'));
    for (let t = 0; t < 86400 * 3; t += 997) {
      const v = showerIntensity(t, 'monsoon');
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
    }
    expect(showerIntensity(5000, 'unknown')).toBe(0);
    expect(showerIntensity(Number.NaN, 'monsoon')).toBe(0);
  });
  it('changes gradually: a shower builds up and fades rather than flickering', () => {
    let jumps = 0;
    for (let t = 0; t < 86400 * 10; t += 60) if (Math.abs(showerIntensity(t + 60, 'monsoon') - showerIntensity(t, 'monsoon')) > 0.25) jumps++;
    expect(jumps).toBe(0);
  });
});
