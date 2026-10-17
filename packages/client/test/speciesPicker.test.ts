import { expect, it } from 'vitest';
import { pickerGroups } from '../src/speciesPicker.js';

it('offers only this world\'s species, grouped by kind, with readable names and counts', () => {
  const groups = pickerGroups({ blue_duiker: 21918, bay_duiker: 4397, african_leopard: 71, tiger: 0 });
  expect(groups).toEqual([
    { label: 'Predators', options: [{ value: 'african_leopard', label: 'African leopard (71)' }] },
    { label: 'Hoofed animals', options: [{ value: 'blue_duiker', label: 'Blue duiker (21,918)' }, { value: 'bay_duiker', label: 'Bay duiker (4,397)' }] },
  ]);
  expect(pickerGroups(undefined)).toEqual([]);
});
