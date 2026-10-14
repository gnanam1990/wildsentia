import { describe, expect, it } from 'vitest';
import { climbPose, climbs, flies } from '../src/animation.js';
import { visualFor, visualForAnimal } from '../src/species.js';
import { feedSentence } from '../src/hud.js';

// Phase B (docs/2026-10-14-congo-phase-b-research.md): the forest elephant, agile mangabey,
// crowned eagle and dwarf crocodile in the forest view; the Congo's climbers drawn climbing.
describe('the Congo forest view, Phase B', () => {
  it('draws each new animal from its own model, at its own size', () => {
    for (const [id, file, lo, hi] of [['forest_elephant', 'ForestElephant', 2.0, 2.6], ['agile_mangabey', 'AgileMangabey', 0.35, 0.6],
      ['crowned_eagle', 'CrownedEagle', 0.5, 0.8], ['dwarf_crocodile', 'DwarfCrocodile', 0.3, 0.5]] as const) {
      const v = visualFor(id);
      expect(v.model?.file, id).toBe(`/assets/animals/${file}.glb`);
      expect(v.heightM, id).toBeGreaterThanOrEqual(lo); expect(v.heightM, id).toBeLessThanOrEqual(hi);
    }
  });
  it('draws the eagle with its wings open in the air, and folded on the ground', () => {
    const eagle = { speciesId: 'crowned_eagle', sex: 'female', lifeStage: 'adult' } as const;
    expect(visualForAnimal(eagle, true).model?.file).toBe('/assets/animals/CrownedEagleFlying.glb');
    expect(visualForAnimal(eagle, false).model?.file).toBe('/assets/animals/CrownedEagle.glb');
  });
  it('knows who climbs and who flies in the Congo', () => {
    for (const id of ['african_leopard', 'african_golden_cat', 'agile_mangabey', 'langur', 'leopard']) expect(climbs(id), id).toBe(true);
    for (const id of ['crowned_eagle', 'vulture']) expect(flies(id), id).toBe(true);
    expect(flies('dwarf_crocodile')).toBe(false);
    // Cats come down head first; a monkey backs down.
    expect(climbPose('african_leopard', 'descending', 1).pitch).toBeCloseTo(Math.PI / 2);
    expect(climbPose('african_golden_cat', 'descending', 1).pitch).toBeCloseTo(Math.PI / 2);
    expect(climbPose('agile_mangabey', 'descending', 1).pitch).toBeCloseTo(-Math.PI / 2);
  });
  it('names them in the feed', () => {
    expect(feedSentence({ type: 'hunt', outcome: 'success', actors: ['crowned_eagle_0001', 'agile_mangabey_0002'] })).toBe('A crowned eagle caught an agile mangabey');
    expect(feedSentence({ type: 'drank', outcome: 'success', actors: ['forest_elephant_0003'] })).toMatch(/^A forest elephant/);
    expect(feedSentence({ type: 'scavenged', outcome: 'success', actors: ['dwarf_crocodile_0004', 'blue_duiker_0005'] })).toMatch(/^A dwarf crocodile fed on a blue duiker/);
  });
});
