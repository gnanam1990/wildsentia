/** The kinds the species are browsed by, in order; a species in none of them is listed last. */
const GROUPS: ReadonlyArray<{ label: string; species: readonly string[] }> = [
  { label: 'Predators', species: ['african_leopard', 'african_golden_cat', 'tiger', 'leopard', 'dhole', 'jackal'] },
  { label: 'Hoofed animals', species: ['blue_duiker', 'bay_duiker', 'peters_duiker', 'water_chevrotain', 'sitatunga', 'forest_buffalo',
    'red_river_hog', 'chital', 'sambar', 'gaur', 'boar'] },
  { label: 'Elephants', species: ['forest_elephant', 'elephant'] },
  { label: 'Monkeys', species: ['agile_mangabey', 'langur'] },
  { label: 'Small animals', species: ['squirrel', 'hare'] },
  { label: 'Birds', species: ['crowned_eagle', 'vulture'] },
  { label: 'Reptiles', species: ['dwarf_crocodile'] },
];

const NAMES: Record<string, string> = {
  peters_duiker: "Peters's duiker", african_leopard: 'African leopard', african_golden_cat: 'African golden cat',
  boar: 'Wild boar', squirrel: 'Giant squirrel', human: 'Villager',
};

export interface SpeciesChoice { id: string; name: string; count: number }
export interface SpeciesGroup { label: string; species: SpeciesChoice[] }

/** A species' readable name: "blue_duiker" is "Blue duiker". */
export function speciesName(id: string): string {
  const name = NAMES[id] ?? id.replaceAll('_', ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The species alive in this world, by kind, most numerous first within a kind. */
export function speciesGroups(population: Readonly<Record<string, number>> | undefined): SpeciesGroup[] {
  const alive = Object.entries(population ?? {}).filter(([, n]) => n > 0);
  const choice = ([id, count]: [string, number]): SpeciesChoice => ({ id, name: speciesName(id), count });
  const byCount = (a: SpeciesChoice, b: SpeciesChoice) => b.count - a.count || a.name.localeCompare(b.name);
  const grouped = new Set(GROUPS.flatMap((g) => g.species));
  const groups = GROUPS.map((g) => ({ label: g.label, species: alive.filter(([id]) => g.species.includes(id)).map(choice).sort(byCount) }));
  groups.push({ label: 'Other animals', species: alive.filter(([id]) => !grouped.has(id)).map(choice).sort(byCount) });
  return groups.filter((g) => g.species.length > 0);
}

/** An animal's name: its species and its own number ("Agile mangabey #91f8"). */
export function animalTitle(id: string): string {
  const last = id.lastIndexOf('_');
  return last > 0 ? `${speciesName(id.slice(0, last))} #${id.slice(last + 1)}` : id;
}

/** Sex, age stage, what it is doing and its age. */
export function animalDetail(row: { sex: string; stage: string; state: string; ageDays: number }): string {
  const age = row.ageDays >= 365 ? `${(row.ageDays / 365).toFixed(1)} years` : `${row.ageDays} days`;
  const sex = row.sex.charAt(0).toUpperCase() + row.sex.slice(1);
  return [sex, row.stage, row.state.replaceAll('_', ' '), age].join(' · ');
}
