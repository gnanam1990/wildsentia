import { describe, expect, it } from 'vitest';
import type { Agent } from '@vana/shared';
import { safariAnswer } from '../src/experiences/moments.js';
import type { CheckpointObservation } from '../src/simHost.js';

const animal = (id: string, speciesId: string) => ({ id, speciesId, alive: true, state: 'resting', currentGoal: 'rest',
  drives: { hunger: 0.2, thirst: 0.1, fatigue: 0.3, fear: 0 }, offspringIds: [] }) as unknown as Agent;
const view = (animals: Agent[]) => ({ worldTime: 100, livingAnimals: () => animals, animal: (id: string) => animals.find((a) => a.id === id) }) as unknown as CheckpointObservation;
const congo = view([animal('african_leopard_0001', 'african_leopard'), animal('forest_buffalo_0002', 'forest_buffalo'),
  animal('blue_duiker_0003', 'blue_duiker'), animal('african_golden_cat_0004', 'african_golden_cat'), animal('red_river_hog_0005', 'red_river_hog')]);

// The guide answers about the world it watches: in the Congo forest, a leopard is an African
// leopard, a duiker a duiker, and its suggestions name the Congo's own animals.
describe('the safari guide in the Congo forest', () => {
  it('finds the Congo animal a question names', () => {
    expect(safariAnswer('Show me a leopard', null, congo, []).animalId).toBe('african_leopard_0001');
    expect(safariAnswer('Tell me about a forest buffalo', null, congo, []).animalId).toBe('forest_buffalo_0002');
    expect(safariAnswer('where is a duiker?', null, congo, []).animalId).toBe('blue_duiker_0003');
    expect(safariAnswer('a golden cat?', null, congo, []).animalId).toBe('african_golden_cat_0004');
    expect(safariAnswer('show me a pig', null, congo, []).animalId).toBe('red_river_hog_0005');
  });
  it('finds the Phase B animals by their everyday names', () => {
    const forest = view([animal('forest_elephant_0001', 'forest_elephant'), animal('agile_mangabey_0002', 'agile_mangabey'),
      animal('crowned_eagle_0003', 'crowned_eagle'), animal('dwarf_crocodile_0004', 'dwarf_crocodile')]);
    expect(safariAnswer('Show me an elephant', null, forest, []).animalId).toBe('forest_elephant_0001');
    expect(safariAnswer('where are the monkeys?', null, forest, []).animalId).toBe('agile_mangabey_0002');
    expect(safariAnswer('is there an eagle?', null, forest, []).animalId).toBe('crowned_eagle_0003');
    expect(safariAnswer('a crocodile!', null, forest, []).animalId).toBe('dwarf_crocodile_0004');
  });
  it('still finds the island\'s animals on the island', () => {
    const island = view([animal('tiger_0001', 'tiger'), animal('leopard_0002', 'leopard')]);
    expect(safariAnswer('Show me a tiger', null, island, []).animalId).toBe('tiger_0001');
    expect(safariAnswer('Show me a leopard', null, island, []).animalId).toBe('leopard_0002');
  });
  it('suggests the Congo\'s own animals, never a tiger or an elephant', () => {
    const moment = { id: 'e1', type: 'hunt', actorId: 'african_leopard_0001', worldTime: 90, title: 'A hunt reached its conclusion', detail: 'It ate.', replay: null, position: null };
    const answer = safariAnswer('what is happening?', null, congo, [moment]).answer;
    expect(answer).not.toMatch(/tiger|elephant/);
    expect(answer).toMatch(/leopard/);
  });
});
