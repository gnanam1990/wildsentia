import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSpeciesDir } from '../src/config/loader.js';

const DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const SOURCES = JSON.parse(readFileSync(fileURLToPath(new URL('../../../config/species-congo.sources.json', import.meta.url)), 'utf8')) as Record<string, unknown>;

describe('the Congo species (1B)', () => {
  const species = loadSpeciesDir(DIR);
  it('are the 1B three, the 2A six and the Phase B four, each with its sources', () => {
    expect([...species.keys()].sort()).toEqual(['african_golden_cat', 'african_leopard', 'agile_mangabey', 'bay_duiker', 'blue_duiker',
      'crowned_eagle', 'dwarf_crocodile', 'forest_buffalo', 'forest_elephant', 'peters_duiker', 'red_river_hog', 'sitatunga', 'water_chevrotain']);
    for (const id of species.keys()) expect(SOURCES[id], id).toBeTruthy();
  });
  it('each carry a persona for players: one temperament word and a short sketch (docs/2026-10-15-congo-species-behaviour-audit.md)', () => {
    for (const [id, cfg] of species) {
      expect(cfg.persona, id).toBeDefined();
      expect(['shy', 'secretive', 'wary', 'bold', 'sociable', 'placid', 'imperious'], id).toContain(cfg.persona!.temperament);
      expect(cfg.persona!.sketch.length, id).toBeGreaterThan(60);
      expect(cfg.persona!.sketch.length, id).toBeLessThan(400);
    }
    expect(species.get('blue_duiker')!.persona!.temperament).toBe('shy');
    expect(species.get('african_leopard')!.persona!.temperament).toBe('bold');
  });
  it('live and eat as the behaviour audit found them to (docs/2026-10-15-congo-species-behaviour-audit.md)', () => {
    const g = (id: string) => species.get(id)!;
    // Elephant families keep together: a lone cow is not a family.
    expect(g('forest_elephant').social.groupSize[0]).toBe(2);
    // Duikers listen for the mangabey troop's alarm calls.
    for (const id of ['blue_duiker', 'peters_duiker']) expect(g(id).social.heedsAlarmOf, id).toContain('agile_mangabey');
    // The mangabey eats mostly fruit and seeds (the forest's fallen fruit, `roots`), and some leaves.
    const eats = g('agile_mangabey').diet.eats;
    expect(eats.find((e) => e.target === 'roots')?.preference).toBe(1);
    expect(eats.find((e) => e.target === 'browse')?.preference).toBeLessThan(0.5);
    // The golden cat takes juvenile mangabeys, never an adult (6-10 kg), and still a blue duiker.
    expect(g('african_golden_cat').hunting!.maxPreyKg).toBeLessThan(g('agile_mangabey').body.massBySexKg!.female);
    expect(g('african_golden_cat').hunting!.maxPreyKg).toBeGreaterThan(g('blue_duiker').body.adultMassKg);
    // The sitatunga is solitary or in small groups of females, not a pair.
    expect(g('sitatunga').social.structure).toBe('solitary');
    expect(g('sitatunga').social.groupSize).toEqual([1, 3]);
  });
  it('sit inside the published ranges', () => {
    const leopard = species.get('african_leopard')!, duiker = species.get('blue_duiker')!, chevrotain = species.get('water_chevrotain')!;
    expect(leopard.body.massBySexKg).toEqual({ female: 30, male: 45 });
    expect(leopard.lifecycle.gestationDays).toBe(96);
    expect(leopard.hunting!.preferredPrey).toEqual(['blue_duiker', 'water_chevrotain', 'bay_duiker', 'peters_duiker', 'red_river_hog',
      'forest_buffalo', 'sitatunga', 'agile_mangabey', 'african_golden_cat']);
    expect(leopard.hunting!.cachesKills).toBe(false);
    expect(duiker.body.adultMassKg).toBeGreaterThanOrEqual(3.5); expect(duiker.body.adultMassKg).toBeLessThanOrEqual(9);
    expect(duiker.lifecycle.gestationDays).toBeGreaterThanOrEqual(196); expect(duiker.lifecycle.gestationDays).toBeLessThanOrEqual(216);
    expect(duiker.social.structure).toBe('pair');
    expect(chevrotain.locomotion.swims).toEqual({ swimMs: 0.7, diveSeconds: 240 });
    expect(chevrotain.lifecycle.gestationDays).toBeGreaterThanOrEqual(188); expect(chevrotain.lifecycle.gestationDays).toBeLessThanOrEqual(272);
    // Nocturnal chevrotain, diurnal duiker.
    expect(chevrotain.activity!.hourly[23]).toBe(1); expect(chevrotain.activity!.hourly[12]).toBeLessThan(0.3);
    expect(duiker.activity!.hourly[12]).toBeGreaterThan(0.5); expect(duiker.activity!.hourly[1]).toBeLessThan(0.3);
  });

  it('2A: the six sit inside their published ranges (Ultimate Ungulate, IUCN, Henschel et al.; plan 2A)', () => {
    const g = (id: string) => species.get(id)!;
    const within = (v: number, lo: number, hi: number) => { expect(v).toBeGreaterThanOrEqual(lo); expect(v).toBeLessThanOrEqual(hi); };
    within(g('bay_duiker').body.adultMassKg, 18, 24); within(g('peters_duiker').body.adultMassKg, 15, 24);
    within(g('red_river_hog').body.adultMassKg, 46, 130); within(g('forest_buffalo').body.adultMassKg, 250, 350);
    within(g('sitatunga').body.adultMassKg, 40, 120); within(g('african_golden_cat').body.adultMassKg, 5.5, 16);
    within(g('bay_duiker').lifecycle.gestationDays, 225, 255); within(g('peters_duiker').lifecycle.gestationDays, 225, 255);
    within(g('red_river_hog').lifecycle.gestationDays, 120, 127); within(g('forest_buffalo').lifecycle.gestationDays, 330, 350);
    within(g('sitatunga').lifecycle.gestationDays, 200, 235);
    expect(g('red_river_hog').lifecycle.litterSize[1]).toBeGreaterThanOrEqual(4);
    expect(g('red_river_hog').archetype).toBe('omnivore_rooter');
    expect(g('red_river_hog').social.structure).toBe('herd');
    expect(g('forest_buffalo').social.structure).toBe('herd');
    expect(g('sitatunga').locomotion.swims).toBeDefined();
    expect(g('african_golden_cat').locomotion.climbsTrees).toBe(true);
    // Bay duiker and the hog are nocturnal; Peters's duiker diurnal.
    expect(g('bay_duiker').activity!.hourly[1]).toBe(1); expect(g('bay_duiker').activity!.hourly[13]).toBeLessThan(0.3);
    expect(g('peters_duiker').activity!.hourly[12]).toBeGreaterThan(0.5); expect(g('peters_duiker').activity!.hourly[1]).toBeLessThan(0.3);
  });

  // Phase B (docs/2026-10-14-congo-phase-b-research.md): the forest elephant, the agile mangabey,
  // the crowned eagle and the dwarf crocodile.
  it('Phase B: the four sit inside their published ranges', () => {
    const g = (id: string) => species.get(id)!;
    const within = (v: number, lo: number, hi: number) => { expect(v).toBeGreaterThanOrEqual(lo); expect(v).toBeLessThanOrEqual(hi); };
    const elephant = g('forest_elephant');
    expect(elephant.archetype).toBe('mega_herbivore'); expect(elephant.social.structure).toBe('family');
    within(elephant.body.shoulderHeightM, 2.0, 2.3); within(elephant.lifecycle.gestationDays, 640, 700);
    within(elephant.lifecycle.interBirthIntervalDays, 1700, 2100);
    const mangabey = g('agile_mangabey');
    expect(mangabey.archetype).toBe('arboreal_troop'); expect(mangabey.locomotion.climbsTrees).toBe(true);
    within(mangabey.lifecycle.gestationDays, 165, 175); within(mangabey.social.groupSize[1], 15, 22);
    expect(mangabey.activity!.hourly[12]).toBeGreaterThan(0.5); expect(mangabey.activity!.hourly[1]).toBeLessThan(0.3);
    const eagle = g('crowned_eagle');
    expect(eagle.archetype).toBe('raptor'); expect(eagle.locomotion.flies).toBe(true);
    expect(eagle.hunting!.preferredPrey[0]).toBe('agile_mangabey'); within(eagle.hunting!.maxPreyKg, 8, 20);
    within(eagle.lifecycle.gestationDays, 45, 50); expect(eagle.lifecycle.litterSize).toEqual([1, 1]);
    within(eagle.diet.offRosterShare!, 0.8, 0.95);
    const croc = g('dwarf_crocodile');
    expect(croc.locomotion.swims).toBeDefined(); expect(croc.activity!.hourly[1]).toBe(1); expect(croc.activity!.hourly[12]).toBeLessThan(0.3);
    // A background predator of small prey: invertebrates, fish and frogs, a newborn at most.
    expect(croc.diet.offRosterShare!).toBeGreaterThanOrEqual(0.9); expect(croc.hunting!.maxPreyKg).toBeLessThanOrEqual(2);
    within(croc.lifecycle.litterSize[1], 10, 17);
    // The leopard and the eagle hunt the mangabey; nothing hunts an adult elephant.
    expect(g('african_leopard').hunting!.preferredPrey).toContain('agile_mangabey');
    for (const s of species.values()) expect(s.hunting?.preferredPrey ?? []).not.toContain('forest_elephant');
  });
});
