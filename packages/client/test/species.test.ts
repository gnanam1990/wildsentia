import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SPECIES_VISUALS, visualFor } from '../src/species.js';

const ROSTER = ['tiger', 'dhole', 'sambar', 'chital', 'gaur', 'elephant', 'boar', 'langur', 'squirrel', 'hare', 'vulture', 'jackal'];
const publicDir = fileURLToPath(new URL('../public', import.meta.url));

describe('species visuals', () => {
  it("gives every species in the roster its own entry, not another animal's model", () => {
    // Every species without a model used to render as a deer: elephants included.
    for (const id of ROSTER) expect(SPECIES_VISUALS[id], id).toBeDefined();
  });

  it('points only at model files that ship with the client', () => {
    for (const [id, visual] of Object.entries(SPECIES_VISUALS)) {
      if (visual.model === null) continue;
      expect(existsSync(`${publicDir}${visual.model.file}`), `${id}: ${visual.model.file}`).toBe(true);
    }
  });

  it('sizes each animal to the shoulder height in its species config', () => {
    expect(visualFor('elephant').heightM).toBeCloseTo(2.7);
    expect(visualFor('hare').heightM).toBeCloseTo(0.22);
  });

  it('says plainly when a species is drawn as a stand-in rather than a model', () => {
    expect(visualFor('chital').model).not.toBeNull();
    expect(visualFor('elephant').model).toBeNull();
    expect(visualFor('unknown_species').model).toBeNull();
  });
});
