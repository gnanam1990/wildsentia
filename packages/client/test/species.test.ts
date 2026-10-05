import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modelStatusForAnimal, SPECIES_VISUALS, visualFor, visualForAnimal } from '../src/species.js';

const ROSTER = ['tiger', 'dhole', 'sambar', 'chital', 'gaur', 'elephant', 'boar', 'langur', 'squirrel', 'hare', 'vulture', 'jackal'];
const publicDir = fileURLToPath(new URL('../public', import.meta.url));

describe('species visuals', () => {
  it("gives every species in the roster its own entry, not another animal's model", () => {
    // Every species without a model used to render as a deer: elephants included.
    for (const id of ROSTER) expect(SPECIES_VISUALS[id], id).toBeDefined();
  });

  it('points only at model files that ship with the client', () => {
    for (const [id, visual] of Object.entries(SPECIES_VISUALS)) {
      expect(visual.model, id).not.toBeNull();
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
    expect(visualFor('elephant').model).not.toBeNull();
    expect(visualFor('langur').model).not.toBeNull();
    expect(visualFor('unknown_species').model).toBeNull();
  });
  it('uses shoulder reference heights instead of raised tails for the small mammals', () => {
    // Front-half (head and shoulders) heights of the generated models, measured in Blender.
    expect(visualFor('langur').model?.referenceHeightM).toBe(0.699);
    expect(visualFor('squirrel').model?.referenceHeightM).toBe(0.794);
  });
  it('draws a vulture in the air with the rig that can spread its wings', () => {
    const vulture = { speciesId: 'vulture', sex: 'female', lifeStage: 'adult' } as const;
    expect(visualForAnimal(vulture).model?.file).toBe('/assets/animals/WhiteRumpedVulture.glb');
    expect(visualForAnimal(vulture, true).model?.file).toBe('/assets/animals/Vulture.glb');
    expect(existsSync(`${publicDir}/assets/animals/WhiteRumpedVulture.glb`)).toBe(true);
  });
  it('selects distinct interim adult, subadult and calf-proportion elephant variants', () => {
    const male = { speciesId: 'elephant', sex: 'male', lifeStage: 'adult' };
    expect(visualForAnimal(male).model?.file).toBe('/assets/animals/AsianElephantAdultMale.glb');
    expect(existsSync(`${publicDir}${visualForAnimal(male).model?.file}`)).toBe(true);
    expect(modelStatusForAnimal(male)).toContain('drinking and gait polish');
    const female = { speciesId: 'elephant', sex: 'female', lifeStage: 'adult' };
    expect(visualForAnimal(female).model?.file).toBe('/assets/animals/AsianElephantAdultFemale.glb');
    expect(existsSync(`${publicDir}${visualForAnimal(female).model?.file}`)).toBe(true);
    expect(modelStatusForAnimal(female)).toContain('female proportions');
    for (const sex of ['female', 'male']) {
      expect(visualForAnimal({ speciesId: 'elephant', sex, lifeStage: 'subadult' }).model?.file)
        .toBe('/assets/animals/AsianElephantAdultFemale.glb');
      for (const lifeStage of ['newborn', 'juvenile']) {
        const calf = { speciesId: 'elephant', sex, lifeStage };
        expect(visualForAnimal(calf).model?.file).toBe('/assets/animals/AsianElephantCalf.glb');
        expect(existsSync(`${publicDir}${visualForAnimal(calf).model?.file}`)).toBe(true);
        expect(modelStatusForAnimal(calf)).toContain('proxy');
      }
    }
  });
});
