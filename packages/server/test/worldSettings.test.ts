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

describe('the world profile and its species (Congo 1B)', () => {
  it('serves congo_v1 with the Congo species, and any other profile with the island roster', async () => {
    const { worldProfile } = await import('../src/worldSettings.js');
    expect(worldProfile({}, '/repo/config')).toEqual({ terrainProfile: 'mainland', speciesDir: '/repo/config/species' });
    expect(worldProfile({ VANA_TERRAIN_PROFILE: 'island_v2', SPECIES_DIR: '/s' }, '/repo/config')).toEqual({ terrainProfile: 'island_v2', speciesDir: '/s' });
    expect(worldProfile({ VANA_TERRAIN_PROFILE: 'congo_v1', SPECIES_DIR: '/s' }, '/repo/config')).toEqual({ terrainProfile: 'congo_v1', speciesDir: '/repo/config/species-congo' });
    expect(worldProfile({ VANA_TERRAIN_PROFILE: 'congo_v1', SPECIES_DIR_CONGO: '/c' }, '/repo/config')).toEqual({ terrainProfile: 'congo_v1', speciesDir: '/c' });
    expect(() => worldProfile({ VANA_TERRAIN_PROFILE: 'atlantis' }, '/repo/config')).toThrow('VANA_TERRAIN_PROFILE');
  });
});
