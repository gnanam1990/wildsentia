import { describe, expect, it } from 'vitest';
import { worldSettings } from '../src/worldSettings.js';

describe('world settings', () => {
  it('defaults to seed 1 at 12 world hours a real hour, and takes valid values', () => {
    expect(worldSettings({})).toEqual({ seed: 1, worldHoursPerRealHour: 12 });
    expect(worldSettings({ WORLD_SEED: '42', WORLD_HOURS_PER_REAL_HOUR: '0.5' })).toEqual({ seed: 42, worldHoursPerRealHour: 0.5 });
  });

  it('refuses a seed or speed that would run the wrong world or stop its clock', () => {
    for (const WORLD_SEED of ['abc', '1.5', '']) expect(() => worldSettings({ WORLD_SEED })).toThrow(/WORLD_SEED/);
    for (const WORLD_HOURS_PER_REAL_HOUR of ['0', '-3', 'fast', '1e9']) expect(() => worldSettings({ WORLD_HOURS_PER_REAL_HOUR })).toThrow(/WORLD_HOURS/);
  });
});
