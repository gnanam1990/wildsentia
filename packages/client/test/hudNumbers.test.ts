import { describe, expect, it } from 'vitest';
import { Hud, type HudElements, type Passport } from '../src/hud.js';
import { WorldStore } from '../src/protocol.js';

function elements(): HudElements {
  const node = () => ({ innerHTML: '', textContent: '', title: '', querySelector: () => null, querySelectorAll: () => [] }) as unknown as HTMLElement;
  return { clock: node(), season: node(), population: node(), passport: node(), feed: node(), notice: node() };
}
const world = (population: Record<string, unknown>) =>
  ({ type: 'world', worldTime: 3600, formatted: 'x', season: 'monsoon', population });

describe('numbers in the top bar and card', () => {
  it('groups the island population in thousands, not lakhs', () => {
    const nodes = elements(), store = new WorldStore(), hud = new Hud(nodes, store);
    store.apply(world({ chital: 120_000, tiger: 3456 }));
    hud.render(null);
    expect(nodes.population.innerHTML).toContain('123,456 animals');
    expect(nodes.population.innerHTML).toContain('<b>120,000</b>');
  });
  it('never puts a server value that is not a number into the page as markup', () => {
    const nodes = elements(), store = new WorldStore(), hud = new Hud(nodes, store);
    store.apply(world({ chital: 10, tiger: '<img src=x onerror=alert(1)>' }));
    hud.render(null);
    expect(nodes.population.innerHTML).not.toContain('<img');
    expect(nodes.population.innerHTML).toContain('10 animals');
    const animal = { id: 'chital_01', speciesId: 'chital', patchId: 1, state: 'resting',
      currentGoal: 'rest', drives: { hunger: 0.2, thirst: 0, fatigue: 0, fear: 0 } };
    store.apply({ type: 'animals', animals: [animal] });
    hud.passport = { id: 'chital_01', speciesId: 'chital', displayName: 'Chital', sex: 'female', ageDays: 400,
      lifeStage: 'adult', generation: '<svg onload=alert(1)>' as unknown as number, alive: true, massKg: 40, thought: null,
      lineage: { mother: null, father: null, offspring: [] }, skills: [], death: null, timeline: [] } satisfies Passport;
    hud.render('chital_01');
    expect(nodes.passport.innerHTML).not.toContain('<svg');
    expect(nodes.passport.innerHTML).toContain('generation');
  });
});
