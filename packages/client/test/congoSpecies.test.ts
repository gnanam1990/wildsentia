import { describe, expect, it } from 'vitest';
import { modelStatus, visualFor } from '../src/species.js';
import { underWater } from '../src/animals.js';

// Congo 1A.4: the Congo species are drawn, honestly labelled, and a diver is not drawn at all.
describe('the Congo species in the browser', () => {
  it('have models at their shoulder heights, honestly labelled', () => {
    expect(visualFor('african_leopard')).toMatchObject({ heightM: 0.65, model: { file: '/assets/animals/LeopardRigged.glb' } });
    // Their own photoreal surfaces on the Deer rig (no tint: the coat is the model's own).
    expect(visualFor('blue_duiker')).toMatchObject({ heightM: 0.36, model: { file: '/assets/animals/BlueDuiker.glb' } });
    expect(visualFor('water_chevrotain')).toMatchObject({ heightM: 0.35, model: { file: '/assets/animals/WaterChevrotain.glb' } });
    expect(visualFor('blue_duiker').model?.tint).toBeUndefined();
    expect(visualFor('water_chevrotain').model?.tint).toBeUndefined();
    expect(modelStatus('african_leopard')).toMatch(/Temporary/);
    for (const id of ['blue_duiker', 'water_chevrotain']) expect(modelStatus(id)).toMatch(/^Generated .* on the deer rig/);
  });
  it('hides an animal under water', () => {
    expect(underWater({ locomotionMode: 'submerged' })).toBe(true);
    expect(underWater({ locomotionMode: 'climb' })).toBe(false);
    expect(underWater({})).toBe(false);
  });
});

describe('the Congo forest in the happening-now feed', () => {
  it('names Congo species whole', async () => {
    const { feedSentence } = await import('../src/hud.js');
    expect(feedSentence({ type: 'hunt', outcome: 'success', actors: ['african_leopard_002a', 'blue_duiker_00ab'] })).toBe('An African leopard caught a blue duiker');
    expect(feedSentence({ type: 'fed', outcome: 'success', actors: ['african_leopard_002a'] })).toBe('An African leopard ate');
    expect(feedSentence({ type: 'fed', outcome: 'success', actors: ['water_chevrotain_0003'] })).toBe('A water chevrotain grazed');
    expect(feedSentence({ type: 'hunt', outcome: 'success', actors: ['tiger_0001', 'chital_0002'] })).toBe('A tiger caught a chital');
  });
});
