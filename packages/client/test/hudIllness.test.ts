import { describe, expect, it } from 'vitest';
import { Hud, type HudElements } from '../src/hud.js';
import { WorldStore } from '../src/protocol.js';

const elements = (): HudElements => ({
  clock: { innerHTML: '' } as HTMLElement,
  season: { innerHTML: '' } as HTMLElement,
  population: { innerHTML: '' } as HTMLElement,
  passport: { innerHTML: '' } as HTMLElement,
  feed: { innerHTML: '' } as HTMLElement,
  notice: { textContent: '' } as HTMLElement,
});

describe('checkpointed illness in the observer', () => {
  it('shows a cautious symptom label only for an authoritative active episode', () => {
    const store = new WorldStore(), nodes = elements(), hud = new Hud(nodes, store);
    const animal = { id: 'vulture_01', speciesId: 'vulture', patchId: 1, state: 'resting',
      currentGoal: 'rest', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } };
    store.apply({ type: 'animals', animals: [{ ...animal, illnessStatus: 'symptomatic' }] });
    hud.render(animal.id);
    expect(nodes.passport.innerHTML).toContain('Modelled illness symptoms');
    expect(nodes.passport.innerHTML).not.toContain('diagnosis');
    store.apply({ type: 'animals', animals: [animal] });
    hud.render(animal.id);
    expect(nodes.passport.innerHTML).not.toContain('Health');
  });
  it('shows a modelled wound phase without presenting it as a diagnosis or permanent state', () => {
    const store = new WorldStore(), nodes = elements(), hud = new Hud(nodes, store);
    const animal = { id: 'chital_01', speciesId: 'chital', patchId: 1, state: 'resting',
      currentGoal: 'rest', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } };
    store.apply({ type: 'animals', animals: [{ ...animal, woundStatus: 'open' }] });
    hud.render(animal.id);
    expect(nodes.passport.innerHTML).toContain('Modelled open wound');
    store.apply({ type: 'animals', animals: [{ ...animal, woundStatus: 'infected' }] });
    hud.render(animal.id);
    expect(nodes.passport.innerHTML).toContain('Modelled wound infection');
    expect(nodes.passport.innerHTML).not.toContain('diagnosis');
    store.apply({ type: 'animals', animals: [animal] });
    hud.render(animal.id);
    expect(nodes.passport.innerHTML).not.toContain('Modelled wound');
  });
});
