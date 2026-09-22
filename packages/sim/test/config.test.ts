import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSpeciesDir, parseSpecies } from '../src/config/loader.js';

const CONFIG_DIR = fileURLToPath(new URL('../../../config/species', import.meta.url));
const species = loadSpeciesDir(CONFIG_DIR);

const ARCHETYPES = new Set([
  'apex_predator', 'pack_predator', 'herd_grazer',
  'mega_herbivore', 'omnivore_rooter', 'arboreal_troop', 'scavenger_flyer',
]);

describe('species config', () => {
  it('loads the full twelve-species roster', () => {
    expect(species.size).toBe(12);
    for (const id of ['tiger', 'dhole', 'sambar', 'chital', 'gaur', 'elephant',
                      'boar', 'langur', 'squirrel', 'hare', 'vulture', 'jackal']) {
      expect(species.has(id)).toBe(true);
    }
  });

  it('uses only the seven archetypes', () => {
    for (const config of species.values()) expect(ARCHETYPES.has(config.archetype)).toBe(true);
  });

  it('covers every archetype at least once', () => {
    const used = new Set([...species.values()].map((c) => c.archetype));
    expect(used.size).toBe(7);
  });

  it('gives every predator a hunting block naming real prey', () => {
    for (const config of species.values()) {
      if (config.archetype !== 'apex_predator' && config.archetype !== 'pack_predator') continue;
      expect(config.hunting).toBeDefined();
      for (const prey of config.hunting!.preferredPrey) expect(species.has(prey)).toBe(true);
    }
  });

  it('rejects a predator archetype with no hunting block', () => {
    const tiger = species.get('tiger')!;
    const { hunting, ...withoutHunting } = tiger;
    void hunting;
    expect(() => parseSpecies(withoutHunting)).toThrow(/hunting block/i);
  });

  it('rejects a meat eater that neither hunts nor scavenges', () => {
    const jackal = species.get('jackal')!;
    expect(() => parseSpecies({ ...jackal, diet: { ...jackal.diet, canScavenge: false } }))
      .toThrow(/hunt or scavenge/i);
  });

  it('rejects a carrion tolerance outside 0 to 1', () => {
    const vulture = species.get('vulture')!;
    expect(() => parseSpecies({ ...vulture, diet: { ...vulture.diet, carrionTolerance: 1.4 } })).toThrow();
  });

  it('rejects a group size whose minimum exceeds its maximum', () => {
    const chital = species.get('chital')!;
    expect(() => parseSpecies({ ...chital, social: { ...chital.social, groupSize: [9, 3] } }))
      .toThrow(/groupSize/i);
  });

  it('gives vultures the highest carrion tolerance in the roster', () => {
    const tolerances = [...species.values()].map((c) => c.diet.carrionTolerance);
    expect(species.get('vulture')!.diet.carrionTolerance).toBe(Math.max(...tolerances));
  });

  it('still requires sprint to exceed walk', () => {
    const hare = species.get('hare')!;
    expect(() => parseSpecies({ ...hare, locomotion: { ...hare.locomotion, sprintMs: 0.1 } }))
      .toThrow(/sprint/i);
  });
});
