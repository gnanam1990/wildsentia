import { describe, expect, it } from 'vitest';
import { animalsInArea, nearestAnimal, sortForList, speciesColour, speciesCounts, unpackAnimalMap, viewArea, zoomAt } from '../src/animalMapModel.js';

// The animal map: every living animal drawn at once, and the list of those in the part shown.
describe('animal map', () => {
  const payload = {
    worldTime: 3600,
    species: [
      { id: 'blue_duiker', ids: '00e5,0110,070d', xz: [100, 200, 5000, 5000, 120, 210] },
      { id: 'african_leopard', ids: '8e47,=odd_one', xz: [110, 205, 9000, 9000] },
      { id: 'sitatunga', ids: '', xz: [] },
    ],
  };
  const animals = unpackAnimalMap(payload);

  it('unpacks each species\' ids and positions, a whole id marked =', () => {
    expect(animals).toEqual([
      { id: 'blue_duiker_00e5', speciesId: 'blue_duiker', x: 100, z: 200 },
      { id: 'blue_duiker_0110', speciesId: 'blue_duiker', x: 5000, z: 5000 },
      { id: 'blue_duiker_070d', speciesId: 'blue_duiker', x: 120, z: 210 },
      { id: 'african_leopard_8e47', speciesId: 'african_leopard', x: 110, z: 205 },
      { id: 'odd_one', speciesId: 'african_leopard', x: 9000, z: 9000 },
    ]);
    expect(speciesCounts(animals)).toEqual([{ speciesId: 'blue_duiker', count: 3 }, { speciesId: 'african_leopard', count: 2 }]);
  });

  it('lists the shown animals in an area, most numerous species first, each in id order', () => {
    const shown = new Set(['blue_duiker', 'african_leopard']);
    const area = { minX: 0, minZ: 0, maxX: 1000, maxZ: 1000 };
    expect(animalsInArea(animals, area, shown).map((a) => a.id)).toEqual(['blue_duiker_00e5', 'blue_duiker_070d', 'african_leopard_8e47']);
    expect(animalsInArea(animals, area, new Set(['african_leopard'])).map((a) => a.id)).toEqual(['african_leopard_8e47']);
    expect(sortForList([{ id: 'b_2', speciesId: 'b' }, { id: 'a_1', speciesId: 'a' }, { id: 'b_1', speciesId: 'b' }]).map((r) => r.id)).toEqual(['b_1', 'b_2', 'a_1']);
  });

  it('picks the nearest shown animal within reach of a click, or none', () => {
    const shown = new Set(['blue_duiker', 'african_leopard']);
    expect(nearestAnimal(animals, 111, 206, 20, shown)?.id).toBe('african_leopard_8e47');
    expect(nearestAnimal(animals, 111, 206, 20, new Set(['blue_duiker']))?.id).toBe('blue_duiker_070d');
    expect(nearestAnimal(animals, 3000, 3000, 20, shown)).toBeNull();
  });

  it('zooms about the pointer, keeping the world point under it, within its limits', () => {
    const view = { cx: 1000, cz: 1000, scale: 0.1 };
    const zoomed = zoomAt(view, 2, 300, 100, 400, 400, 0.01, 2);
    // The point under the pointer (2000, 0) stays under it.
    expect(zoomed.scale).toBe(0.2);
    expect(zoomed.cx + (300 - 200) / zoomed.scale).toBeCloseTo(2000);
    expect(zoomed.cz + (100 - 200) / zoomed.scale).toBeCloseTo(0);
    expect(zoomAt(view, 1000, 200, 200, 400, 400, 0.01, 2).scale).toBe(2);
    expect(viewArea({ cx: 0, cz: 0, scale: 0.5 }, 400, 200)).toEqual({ minX: -400, maxX: 400, minZ: -200, maxZ: 200 });
  });

  it('gives every species a colour, the same each time', () => {
    expect(speciesColour('african_leopard')).toMatch(/^#[0-9a-f]{6}$/);
    expect(speciesColour('unknown_species')).toBe(speciesColour('unknown_species'));
  });
});
