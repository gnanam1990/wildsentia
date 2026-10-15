import { describe, expect, it } from 'vitest';
import { modelStatus, visualFor } from '../src/species.js';
import { airborne, underWater } from '../src/animals.js';

// Congo 1A.4: the Congo species are drawn, honestly labelled, and a diver is not drawn at all.
describe('the Congo species in the browser', () => {
  it('have models at their shoulder heights, honestly labelled', () => {
    expect(visualFor('african_leopard')).toMatchObject({ heightM: 0.65, model: { file: '/assets/animals/AfricanLeopard.glb' } });
    // Their own photoreal surfaces on the Deer rig (no tint: the coat is the model's own).
    expect(visualFor('blue_duiker')).toMatchObject({ heightM: 0.36, model: { file: '/assets/animals/BlueDuiker.glb' } });
    expect(visualFor('water_chevrotain')).toMatchObject({ heightM: 0.35, model: { file: '/assets/animals/WaterChevrotain.glb' } });
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

// Congo 2A (docs/superpowers/plans/2026-10-14-congo-2a-species.md): six more species, drawn with
// models of their own at their shoulder heights, named in the feed.
describe('the Congo 2A species in the browser', () => {
  const SIX: Array<[string, string, number]> = [
    ['bay_duiker', 'BayDuiker', 0.5], ['peters_duiker', 'PetersDuiker', 0.52], ['red_river_hog', 'RedRiverHog', 0.7],
    ['forest_buffalo', 'ForestBuffalo', 1.2], ['sitatunga', 'Sitatunga', 1.0], ['african_golden_cat', 'AfricanGoldenCat', 0.42],
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
