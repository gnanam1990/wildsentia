import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSpeciesDir, parseSpecies } from '../src/config/loader.js';

const CONFIG_DIR = fileURLToPath(new URL('../../../config/species', import.meta.url));

describe('species config', () => {
  it('loads every species file in the config directory', () => {
    const species = loadSpeciesDir(CONFIG_DIR);
    expect(species.has('sambar')).toBe(true);
    expect(species.has('tiger')).toBe(true);
    expect(species.get('sambar')!.archetype).toBe('herd_grazer');
  });

  it('rejects a config with a negative intake', () => {
    expect(() => parseSpecies({ id: 'broken', diet: { dailyIntakeKg: -1 } })).toThrow();
  });

  it('rejects an unknown archetype', () => {
    const sambar = loadSpeciesDir(CONFIG_DIR).get('sambar')!;
    expect(() => parseSpecies({ ...sambar, archetype: 'dragon' })).toThrow();
  });

  it('requires sprint to be faster than walk', () => {
    const sambar = loadSpeciesDir(CONFIG_DIR).get('sambar')!;
    expect(() => parseSpecies({ ...sambar, locomotion: { ...sambar.locomotion, sprintMs: 0.1 } }))
      .toThrow(/sprint/i);
  });
});
