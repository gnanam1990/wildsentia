import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSpeciesDir } from '../src/config/loader.js';

const DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const SOURCES = JSON.parse(readFileSync(fileURLToPath(new URL('../../../config/species-congo.sources.json', import.meta.url)), 'utf8')) as Record<string, unknown>;

describe('the Congo species (1B)', () => {
  const species = loadSpeciesDir(DIR);
  it('are the African leopard, blue duiker and water chevrotain, each with its sources', () => {
    expect([...species.keys()].sort()).toEqual(['african_leopard', 'blue_duiker', 'water_chevrotain']);
    for (const id of species.keys()) expect(SOURCES[id], id).toBeTruthy();
  });
  it('sit inside the published ranges', () => {
    const leopard = species.get('african_leopard')!, duiker = species.get('blue_duiker')!, chevrotain = species.get('water_chevrotain')!;
    expect(leopard.body.massBySexKg).toEqual({ female: 30, male: 45 });
    expect(leopard.lifecycle.gestationDays).toBe(96);
    expect(leopard.hunting!.preferredPrey).toEqual(['blue_duiker', 'water_chevrotain']);
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
});
