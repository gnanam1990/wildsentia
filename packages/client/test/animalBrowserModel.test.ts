import { describe, expect, it } from 'vitest';
import { animalDetail, animalTitle, speciesGroups, speciesName } from '../src/animalBrowserModel.js';

describe('choosing an animal to watch', () => {
  it('groups the species alive in this world by kind, with readable names and counts', () => {
    const groups = speciesGroups({ blue_duiker: 21918, african_leopard: 71, agile_mangabey: 3391, crowned_eagle: 274,
      dwarf_crocodile: 707, forest_elephant: 923, red_river_hog: 3900, tiger: 0 });
    expect(groups.map((g) => g.label)).toEqual(['Predators', 'Hoofed animals', 'Elephants', 'Monkeys', 'Birds', 'Reptiles']);
    const hoofed = groups.find((g) => g.label === 'Hoofed animals')!;
    expect(hoofed.species).toEqual([{ id: 'blue_duiker', name: 'Blue duiker', count: 21918 }, { id: 'red_river_hog', name: 'Red river hog', count: 3900 }]);
    // None of the island's species that this world does not hold.
    expect(groups.flatMap((g) => g.species).some((s) => s.id === 'tiger')).toBe(false);
    // An unknown species is still listed, not lost.
    expect(speciesGroups({ okapi: 3 }).at(-1)).toEqual({ label: 'Other animals', species: [{ id: 'okapi', name: 'Okapi', count: 3 }] });
  });

  it('names an animal by its species and its own number, and says what it is doing', () => {
    expect(speciesName('peters_duiker')).toBe("Peters's duiker");
    expect(speciesName('african_golden_cat')).toBe('African golden cat');
    expect(animalTitle('agile_mangabey_91f8')).toBe('Agile mangabey #91f8');
    expect(animalDetail({ sex: 'female', stage: 'adult', state: 'resting', ageDays: 1753 })).toBe('Female · adult · resting · 4.8 years');
    expect(animalDetail({ sex: 'male', stage: 'juvenile', state: 'grazing', ageDays: 40 })).toBe('Male · juvenile · grazing · 40 days');
  });
});
