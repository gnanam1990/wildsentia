import { describe, expect, it } from 'vitest';
import { modelStatus, visualFor } from '../src/species.js';
import { airborne, underWater } from '../src/animals.js';

// Congo 1A.4: the Congo species are drawn, honestly labelled, and a diver is not drawn at all.
describe('the Congo species in the browser', () => {
  // Drawn heights are standing heights, to the top of the head: a model is scaled so its whole
  // height is heightM, so a shoulder height there drew every animal a fifth too small.
  it('have models at their standing heights, honestly labelled', () => {
    expect(visualFor('african_leopard')).toMatchObject({ heightM: 0.78, model: { file: '/assets/animals/AfricanLeopard.glb' } });
    // Their own photoreal surfaces on the Deer rig (no tint: the coat is the model's own).
    expect(visualFor('blue_duiker')).toMatchObject({ heightM: 0.45, model: { file: '/assets/animals/BlueDuiker.glb' } });
    expect(visualFor('water_chevrotain')).toMatchObject({ heightM: 0.38, model: { file: '/assets/animals/WaterChevrotain.glb' } });
    expect(visualFor('blue_duiker').model?.tint).toBeUndefined();
    expect(visualFor('water_chevrotain').model?.tint).toBeUndefined();
    expect(modelStatus('african_leopard')).toMatch(/^Generated African leopard on its own big-cat rig/);
    expect(modelStatus('african_leopard')).toContain('not motion capture');
    for (const id of ['blue_duiker', 'water_chevrotain']) expect(modelStatus(id)).toMatch(/^Generated .* on the deer rig/);
  });
  it('hides an animal under water', () => {
    expect(underWater({ locomotionMode: 'submerged' })).toBe(true);
    expect(underWater({ locomotionMode: 'climb' })).toBe(false);
    // A crowned eagle perched on a branch stands; one in the air or on a recorded flight spreads its wings.
    expect(airborne({ speciesId: 'crowned_eagle', locomotionMode: 'climb' }, 6, false)).toBe(false);
    expect(airborne({ speciesId: 'crowned_eagle', locomotionMode: 'flight' }, 30, false)).toBe(true);
    expect(airborne({ speciesId: 'crowned_eagle' }, 0, true)).toBe(true);
    expect(airborne({ speciesId: 'african_leopard', locomotionMode: 'climb' }, 6, false)).toBe(false);
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

// Congo 2A (the Congo 2A species plan): six more species, drawn with
// models of their own at their shoulder heights, named in the feed.
describe('the Congo 2A species in the browser', () => {
  const SIX: Array<[string, string, number]> = [
    ['bay_duiker', 'BayDuiker', 0.58], ['peters_duiker', 'PetersDuiker', 0.62], ['red_river_hog', 'RedRiverHog', 0.78],
    ['forest_buffalo', 'ForestBuffalo', 1.4], ['sitatunga', 'Sitatunga', 1.35], ['african_golden_cat', 'AfricanGoldenCat', 0.5],
  ];
  it.each(SIX)('draws %s with %s.glb at %s m, honestly labelled', (id, file, height) => {
    expect(visualFor(id)).toMatchObject({ heightM: height, model: { file: `/assets/animals/${file}.glb` } });
    expect(modelStatus(id)).toMatch(/^Generated /);
  });
  it('names them in the happening-now feed', async () => {
    const { feedSentence } = await import('../src/hud.js');
    expect(feedSentence({ type: 'hunt', outcome: 'success', actors: ['african_leopard_002a', 'red_river_hog_0101'] })).toBe('An African leopard caught a red river hog');
    expect(feedSentence({ type: 'hunt', outcome: 'success', actors: ['african_golden_cat_0007', 'blue_duiker_00ab'] })).toBe('An African golden cat caught a blue duiker');
    expect(feedSentence({ type: 'fed', outcome: 'success', actors: ['african_golden_cat_0007'] })).toBe('An African golden cat ate');
    expect(feedSentence({ type: 'fed', outcome: 'success', actors: ['red_river_hog_0101'] })).toBe('A red river hog foraged');
    expect(feedSentence({ type: 'fed', outcome: 'success', actors: ['forest_buffalo_0003'] })).toBe('A forest buffalo grazed');
    expect(feedSentence({ type: 'hunt', outcome: 'success', actors: ['african_leopard_002a', 'peters_duiker_0002'] })).toBe('An African leopard caught a Peters\'s duiker');
  });
});
