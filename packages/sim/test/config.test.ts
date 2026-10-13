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
  it('bounds optional early plant foraging and does not unlock it for meat-only eaters', () => {
    const hare = species.get('hare')!, dhole = species.get('dhole')!, boar = species.get('boar')!;
    expect(hare.lifecycle.forageFromDays).toBe(8);
    expect(boar.lifecycle.forageFromDays).toBe(21);
    expect(parseSpecies(boar).lifecycle.forageFromDays).toBe(21);
    for (const age of [-1, Infinity, hare.lifecycle.weanDays + 1]) {
      expect(() => parseSpecies({ ...hare, lifecycle: { ...hare.lifecycle, forageFromDays: age } })).toThrow();
    }
    expect(() => parseSpecies({ ...dhole, lifecycle: { ...dhole.lifecycle, forageFromDays: 8 } })).toThrow();
    expect(dhole.lifecycle.forageFromDays).toBeUndefined();
  });
  it('keeps early drinking distinct from solids and bounds it by weaning', () => {
    const boar = species.get('boar')!, dhole = species.get('dhole')!;
    expect(boar.lifecycle).toMatchObject({ drinkFromDays: 10, followFromDays: 10, forageFromDays: 21, weanDays: 90 });
    for (const age of [-1, Infinity, boar.lifecycle.weanDays + 1]) {
      expect(() => parseSpecies({ ...boar, lifecycle: { ...boar.lifecycle, drinkFromDays: age } })).toThrow();
    }
    expect(dhole.lifecycle.drinkFromDays).toBeUndefined();
  });
  it('bounds early meat access to scavenging meat eaters and the weaning window', () => {
    const tiger = species.get('tiger')!, hare = species.get('hare')!;
    expect(tiger.lifecycle).toMatchObject({ meatFromDays: 70, drinkFromDays: 70, weanDays: 180 });
    for (const age of [-1, Infinity, tiger.lifecycle.weanDays + 1]) {
      expect(() => parseSpecies({ ...tiger, lifecycle: { ...tiger.lifecycle, meatFromDays: age } })).toThrow();
    }
    expect(() => parseSpecies({ ...hare, lifecycle: { ...hare.lifecycle, meatFromDays: 70 } })).toThrow();
  });
  it('loads the full thirteen-species roster', () => {
    expect(species.size).toBe(13);
    for (const id of ['tiger', 'dhole', 'sambar', 'chital', 'gaur', 'elephant',
                      'boar', 'langur', 'squirrel', 'hare', 'vulture', 'jackal', 'leopard']) {
      expect(species.has(id)).toBe(true);
    }
  });

  it('gives wild boar field-reported breeding: one litter a year, most piglets lost', () => {
    // Sows in Indian forests farrow about once a year, and half to two-thirds of piglets die in
    // their first year. Two litters a year with most piglets surviving let boar double every
    // few months, faster than any predator or crowding in the forest could hold them.
    const { lifecycle } = species.get('boar')!;
    expect(lifecycle.interBirthIntervalDays).toBeGreaterThanOrEqual(330);

    let hazard = 0;
    const stages = lifecycle.stages;
    for (let i = 0; i < stages.length; i++) {
      const start = stages[i]!.startDays;
      const end = Math.min(stages[i + 1]?.startDays ?? Infinity, 365);
      if (end > start) hazard += (end - start) * stages[i]!.mortalityPerDay;
    }
    const firstYearSurvival = Math.exp(-hazard);
    expect(firstYearSurvival).toBeGreaterThanOrEqual(0.3);
    expect(firstYearSurvival).toBeLessThanOrEqual(0.5);
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

  it('accepts the Congo fields (swimming, prey life stages, freezing first, flooded costs) and bounds them (1B)', () => {
    const leopard = species.get('leopard')!;
    const swimmer = { ...leopard, locomotion: { ...leopard.locomotion, swims: { swimMs: 0.7, diveSeconds: 240 },
      floodedTerrainCost: { flooded_forest: 3 } }, escape: { ...leopard.escape, freezeFirst: true },
      hunting: { ...leopard.hunting!, preyLifeStages: ['juvenile', 'adult'] } };
    expect(parseSpecies(swimmer).locomotion.swims).toEqual({ swimMs: 0.7, diveSeconds: 240 });
    expect(parseSpecies(swimmer).hunting!.preyLifeStages).toEqual(['juvenile', 'adult']);
    expect(parseSpecies(swimmer).escape.freezeFirst).toBe(true);
    expect(parseSpecies(swimmer).locomotion.floodedTerrainCost).toEqual({ flooded_forest: 3 });
    for (const bad of [{ swimMs: 0, diveSeconds: 240 }, { swimMs: 0.7, diveSeconds: -1 }, { swimMs: 0.7, diveSeconds: 3_601 }])
      expect(() => parseSpecies({ ...swimmer, locomotion: { ...swimmer.locomotion, swims: bad } })).toThrow();
    expect(() => parseSpecies({ ...swimmer, hunting: { ...swimmer.hunting, preyLifeStages: ['tadpole'] } })).toThrow();
    // No island species carries any of them.
    for (const s of species.values()) {
      expect(s.locomotion.swims).toBeUndefined();
      expect(s.hunting?.preyLifeStages).toBeUndefined();
    }
  });
});
