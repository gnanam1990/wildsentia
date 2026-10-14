import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSpeciesDir } from '../src/config/loader.js';

const DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const SOURCES = JSON.parse(readFileSync(fileURLToPath(new URL('../../../config/species-congo.sources.json', import.meta.url)), 'utf8')) as Record<string, unknown>;

describe('the Congo species (1B)', () => {
  const species = loadSpeciesDir(DIR);
  it('are the 1B three and the 2A six (docs/superpowers/plans/2026-10-14-congo-2a-species.md), each with its sources', () => {
    expect([...species.keys()].sort()).toEqual(['african_golden_cat', 'african_leopard', 'bay_duiker', 'blue_duiker', 'forest_buffalo',
      'peters_duiker', 'red_river_hog', 'sitatunga', 'water_chevrotain']);
    for (const id of species.keys()) expect(SOURCES[id], id).toBeTruthy();
  });
  it('sit inside the published ranges', () => {
    const leopard = species.get('african_leopard')!, duiker = species.get('blue_duiker')!, chevrotain = species.get('water_chevrotain')!;
    expect(leopard.body.massBySexKg).toEqual({ female: 30, male: 45 });
    expect(leopard.lifecycle.gestationDays).toBe(96);
    expect(leopard.hunting!.preferredPrey).toEqual(['blue_duiker', 'water_chevrotain', 'bay_duiker', 'peters_duiker', 'red_river_hog',
      'forest_buffalo', 'sitatunga', 'african_golden_cat']);
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
});
