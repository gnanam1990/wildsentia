import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createRng, type Agent } from '@vana/shared';
import { loadSpeciesDir } from '../src/config/loader.js';
import { buildGrid } from '../src/grid.js';
import { perceive } from '../src/agents/perception.js';
import { selectGoal } from '../src/agents/goals.js';

const species = loadSpeciesDir(fileURLToPath(new URL('../../../config/species', import.meta.url))).get('sambar')!;
const patches = buildGrid(4);

const makeAgent = (drives: Agent['drives'], patchId = 0): Agent => ({
  id: 'a1', speciesId: 'sambar', bornAt: 0, massKg: 220, patchId,
  state: 'resting', currentGoal: 'rest', alternativeGoal: null, goalScore: 0, drives, alive: true,
});

describe('perceive', () => {
  it('sees only the current patch and its neighbours', () => {
    const p = perceive(makeAgent({ hunger: 0, thirst: 0, fatigue: 0, fear: 0 }, 42), patches, species);
    expect(p.patch.id).toBe(42);
    expect(p.neighbours.map((n) => n.id).sort()).toEqual(patches[42]!.neighbours.slice().sort());
  });
});

describe('selectGoal', () => {
  const rng = createRng(1, 'test');

  it('chooses water when thirst dominates', () => {
    const a = makeAgent({ hunger: 0.2, thirst: 0.95, fatigue: 0.1, fear: 0 });
    expect(selectGoal(a, perceive(a, patches, species), rng).goal).toBe('find_water');
  });

  it('chooses food when hunger dominates', () => {
    const a = makeAgent({ hunger: 0.95, thirst: 0.1, fatigue: 0.1, fear: 0 });
    expect(selectGoal(a, perceive(a, patches, species), rng).goal).toBe('find_food');
  });

  it('chooses rest when exhausted and otherwise satisfied', () => {
    const a = makeAgent({ hunger: 0.1, thirst: 0.1, fatigue: 0.97, fear: 0 });
    expect(selectGoal(a, perceive(a, patches, species), rng).goal).toBe('rest');
  });

  it('always reports a runner-up different from the winner', () => {
    const a = makeAgent({ hunger: 0.6, thirst: 0.5, fatigue: 0.4, fear: 0 });
    const choice = selectGoal(a, perceive(a, patches, species), rng);
    expect(choice.alternative).not.toBe(choice.goal);
    expect(choice.alternative).not.toBeNull();
  });

  it('is deterministic for the same rng seed and state', () => {
    const a = makeAgent({ hunger: 0.6, thirst: 0.55, fatigue: 0.5, fear: 0 });
    const p = perceive(a, patches, species);
    expect(selectGoal(a, p, createRng(7, 'g'))).toEqual(selectGoal(a, p, createRng(7, 'g')));
  });
});
