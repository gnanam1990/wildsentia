import { describe, expect, it } from 'vitest';
import { Hud, type HudElements } from '../src/hud.js';
import { WorldStore } from '../src/protocol.js';

describe('the followed animal\'s card', () => {
  it('is left alone while nothing on it changed, and keeps open sections open when it does change', () => {
    let writes = 0, html = '';
    const sections = [{ className: 'story', open: false }, { className: 'about', open: false }];
    const passport = {
      get innerHTML() { return html; },
      set innerHTML(value: string) { writes++; html = value; for (const s of sections) s.open = false; },
      querySelectorAll: (selector: string) => selector === 'details[open]' ? sections.filter((s) => s.open) : sections,
    } as unknown as HTMLElement;
    const nodes: HudElements = {
      clock: { innerHTML: '' } as HTMLElement, season: { innerHTML: '' } as HTMLElement,
      population: { innerHTML: '' } as HTMLElement, passport, feed: { innerHTML: '' } as HTMLElement,
      notice: { textContent: '' } as HTMLElement,
    };
    const store = new WorldStore(), hud = new Hud(nodes, store);
    const animal = { id: 'chital_01', speciesId: 'chital', patchId: 1, state: 'resting',
      currentGoal: 'rest', drives: { hunger: 0.2, thirst: 0, fatigue: 0, fear: 0 } };
    store.apply({ type: 'animals', animals: [animal] });
    hud.render(animal.id);
    expect(writes).toBe(1);
    // The viewer opens "About this view"; the page re-renders every second with nothing new.
    sections[1]!.open = true;
    hud.render(animal.id);
    hud.render(animal.id);
    expect(writes).toBe(1);
    expect(sections[1]!.open).toBe(true);
    // Hunger rises: the card is rebuilt, and the open section stays open.
    store.apply({ type: 'animals', animals: [{ ...animal, drives: { ...animal.drives, hunger: 0.6 } }] });
    hud.render(animal.id);
    expect(writes).toBe(2);
    expect(html).toContain('Hunger');
    expect(sections.map((s) => s.open)).toEqual([false, true]);
  });
});
