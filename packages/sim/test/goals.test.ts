import { describe, expect, it } from 'vitest';
import { createRng } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { perceive } from '../src/agents/perception.js';
import { selectGoal } from '../src/agents/goals.js';
import { makeCarcass } from '../src/fields/decomposition.js';
import { makeAgent, makeView, speciesOf } from './helpers.js';

const patches = buildGrid(4);
const sambar = speciesOf('sambar');
const tiger = speciesOf('tiger');
const vulture = speciesOf('vulture');

describe('perceive', () => {
  it('sees only the current patch and its neighbours', () => {
    const agent = makeAgent('sambar', { patchId: 42 });
    const p = perceive(agent, sambar, makeView(patches, [agent]));
    expect(p.patch.id).toBe(42);
    expect(p.neighbours.map((n) => n.id).sort()).toEqual(patches[42]!.neighbours.slice().sort());
  });

  it('shows a predator its preferred prey and the size of the herd', () => {
    const hunter = makeAgent('tiger', { id: 't1', patchId: 10 });
    const herd = [0, 1, 2].map((i) => makeAgent('sambar', { id: `s${i}`, patchId: 10 }));
    const p = perceive(hunter, tiger, makeView(patches, [hunter, ...herd]));
    expect(p.prey).toHaveLength(3);
    expect(p.prey[0]!.herdSize).toBe(3);
  });

  it('does not show a grazer any prey', () => {
    const grazer = makeAgent('sambar', { patchId: 10 });
    const other = makeAgent('chital', { id: 'c1', patchId: 10 });
    expect(perceive(grazer, sambar, makeView(patches, [grazer, other])).prey).toHaveLength(0);
  });

  it('shows a scavenger nearby carrion', () => {
    const bird = makeAgent('vulture', { patchId: 10 });
    const carcass = makeCarcass('c1', 'sambar_1', 'sambar', 10, 0, 'predation', 'authoritative', 200);
    const p = perceive(bird, vulture, makeView(patches, [bird], [carcass]));
    expect(p.carrion?.carcass.id).toBe('c1');
  });

  it('does not show carrion to a species that cannot scavenge', () => {
    const grazer = makeAgent('sambar', { patchId: 10 });
    const carcass = makeCarcass('c1', 'x', 'sambar', 10, 0, 'predation', 'authoritative', 200);
    expect(perceive(grazer, sambar, makeView(patches, [grazer], [carcass])).carrion).toBeNull();
  });

  it('shows prey the predator that hunts it as a threat', () => {
    const prey = makeAgent('sambar', { patchId: 10 });
    const hunter = makeAgent('tiger', { id: 't1', patchId: 10 });
    expect(perceive(prey, sambar, makeView(patches, [prey, hunter])).threat?.agent.id).toBe('t1');
  });

  it('does not treat a harmless neighbour as a threat', () => {
    const prey = makeAgent('sambar', { patchId: 10 });
    const bird = makeAgent('vulture', { id: 'v1', patchId: 10 });
    expect(perceive(prey, sambar, makeView(patches, [prey, bird])).threat).toBeNull();
  });
});

describe('selectGoal', () => {
  const rng = createRng(1, 'test');

  it('chooses water when thirst dominates', () => {
    const agent = makeAgent('sambar', { drives: { hunger: 0.2, thirst: 0.95, fatigue: 0.1, fear: 0 } });
    const percept = perceive(agent, sambar, makeView(patches, [agent]));
    expect(selectGoal(agent, sambar, percept, rng).goal).toBe('find_water');
  });

  it('chooses food when hunger dominates', () => {
    const agent = makeAgent('sambar', { drives: { hunger: 0.95, thirst: 0.1, fatigue: 0.1, fear: 0 } });
    const percept = perceive(agent, sambar, makeView(patches, [agent]));
    expect(selectGoal(agent, sambar, percept, rng).goal).toBe('find_food');
  });

  it('chooses rest when exhausted and otherwise satisfied', () => {
    const agent = makeAgent('sambar', { drives: { hunger: 0.1, thirst: 0.1, fatigue: 0.97, fear: 0 } });
    const percept = perceive(agent, sambar, makeView(patches, [agent]));
    expect(selectGoal(agent, sambar, percept, rng).goal).toBe('rest');
  });

  it('flees when frightened and its ordinary needs are met', () => {
    const agent = makeAgent('sambar', { drives: { hunger: 0.4, thirst: 0.4, fatigue: 0.1, fear: 0.9 } });
    const percept = perceive(agent, sambar, makeView(patches, [agent]));
    expect(selectGoal(agent, sambar, percept, rng).goal).toBe('flee');
  });

  it('drinks despite the danger when it is close to dying of thirst', () => {
    const agent = makeAgent('sambar', { drives: { hunger: 0.4, thirst: 0.98, fatigue: 0.1, fear: 0.9 } });
    const percept = perceive(agent, sambar, makeView(patches, [agent]));
    expect(selectGoal(agent, sambar, percept, rng).goal).toBe('find_water');
  });

  it('cannot keep fleeing once it is exhausted', () => {
    const fresh = makeAgent('sambar', { stamina: 1, drives: { hunger: 0.4, thirst: 0.4, fatigue: 0.1, fear: 0.9 } });
    const spent = makeAgent('sambar', { stamina: 0.02, drives: { hunger: 0.4, thirst: 0.4, fatigue: 0.1, fear: 0.9 } });
    const view = makeView(patches, [fresh]);
    const a = selectGoal(fresh, sambar, perceive(fresh, sambar, view), createRng(2, 'x'));
    const b = selectGoal(spent, sambar, perceive(spent, sambar, view), createRng(2, 'x'));
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('hunts when hungry with prey in sight', () => {
    const hunter = makeAgent('tiger', { id: 't1', patchId: 10, drives: { hunger: 0.9, thirst: 0.1, fatigue: 0.1, fear: 0 } });
    const prey = makeAgent('sambar', { id: 's1', patchId: 10 });
    const percept = perceive(hunter, tiger, makeView(patches, [hunter, prey]));
    expect(selectGoal(hunter, tiger, percept, rng).goal).toBe('hunt');
  });

  it('never offers a grazer the hunt goal, however hungry it is', () => {
    const agent = makeAgent('sambar', { drives: { hunger: 1, thirst: 0, fatigue: 0, fear: 0 } });
    const percept = perceive(agent, sambar, makeView(patches, [agent]));
    for (let i = 0; i < 50; i++) {
      expect(selectGoal(agent, sambar, percept, rng).goal).not.toBe('hunt');
    }
  });

  it('prefers carrion over a hunt when a carcass is right there', () => {
    const hunter = makeAgent('tiger', { id: 't1', patchId: 10, drives: { hunger: 0.9, thirst: 0.1, fatigue: 0.1, fear: 0 } });
    const carcass = makeCarcass('c1', 'x', 'sambar', 10, 0, 'predation', 'authoritative', 200);
    const percept = perceive(hunter, tiger, makeView(patches, [hunter], [carcass]));
    expect(selectGoal(hunter, tiger, percept, rng).goal).toBe('scavenge');
  });

  it('always reports a runner-up different from the winner', () => {
    const agent = makeAgent('sambar', { drives: { hunger: 0.6, thirst: 0.5, fatigue: 0.4, fear: 0 } });
    const percept = perceive(agent, sambar, makeView(patches, [agent]));
    const choice = selectGoal(agent, sambar, percept, rng);
    expect(choice.alternative).not.toBe(choice.goal);
    expect(choice.alternative).not.toBeNull();
  });

  it('is deterministic for the same rng seed and state', () => {
    const agent = makeAgent('sambar', { drives: { hunger: 0.6, thirst: 0.55, fatigue: 0.5, fear: 0 } });
    const percept = perceive(agent, sambar, makeView(patches, [agent]));
    expect(selectGoal(agent, sambar, percept, createRng(7, 'g')))
      .toEqual(selectGoal(agent, sambar, percept, createRng(7, 'g')));
  });
});
