import { describe, expect, it } from 'vitest';
import { patchCentre } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { takeSnapshot, restoreSnapshot } from '../src/snapshot.js';
import { SPECIES_DIR } from './helpers.js';

describe('encounters in the authoritative world', () => {
  it('links a real death/carcass to a recorded contact, conserves mass and replays after restart', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const options = { seed, speciesDir: SPECIES_DIR, initialAgents: { tiger: 1, sambar: 2 }, minPopulation: {} };
      const world = createWorld(options);
      const patch = world.patches.find((p) => p.habitat === 'grassland')!;
      const centre = patchCentre(patch.id);
      for (const [i, a] of world.agents.entries()) {
        a.patchId = patch.id; a.position = { x: centre.x + i * 15, z: centre.z, heading: 0 };
        a.sex = 'male'; a.drives = { hunger: a.speciesId === 'tiger' ? 0.8 : 0.2, thirst: 0, fatigue: 0, fear: 0 };
      }
      const nutrients = world.totalNutrients();
      world.step(1);
      const hunt = world.log.all().find((e) => e.type === 'hunt' && e.outcome === 'success');
      if (!hunt) continue;
      const death = world.log.all().find((e) => e.type === 'died' && e.actors[0] === hunt.actors[1])!;
      const carcass = world.carcasses.find((c) => c.originId === hunt.actors[1])!;
      expect(hunt.encounter!.samples.at(-1)!.phase).toBe('contact');
      expect(death.causalParents).toContain(hunt.id);
      expect(death.worldTime).toBe(hunt.worldTime);
      expect(death.worldTime).toBeLessThanOrEqual(world.now());
      expect(carcass.position).toEqual(hunt.encounter!.samples.at(-1)!.prey);
      expect(carcass.consumers.every((c) => c.at >= death.worldTime)).toBe(true);
      const meal = world.log.all().find((e) => e.type === 'fed' && e.conditions.carcassId === carcass.id)!;
      expect(meal).toBeDefined();
      expect(meal.causalParents).toContain(hunt.id);
      expect(meal.worldTime).toBe(world.now());
      expect(Number(meal.conditions.arrivalWorldTime)).toBeGreaterThanOrEqual(hunt.worldTime);
      expect(Number(meal.conditions.feedingSeconds) + hunt.encounter!.samples.at(-1)!.seconds).toBeLessThanOrEqual(3600);
      expect(carcass.consumers.find((c) => c.agentId === hunt.actors[0])!.at).toBe(meal.worldTime);
      for (const event of world.log.all()) expect(event.causalParents).not.toContain(event.id);
      expect(world.totalNutrients()).toBeCloseTo(nutrients, 6);
      const restored = restoreSnapshot(takeSnapshot(world), options);
      world.log.take();
      for (let h = 0; h < 20; h++) { world.step(1); restored.step(1); }
      expect(restored.log.all()).toEqual(world.log.all());
      expect(restored.agents).toEqual(world.agents);
      return;
    }
    throw new Error('fixture did not observe a kill in 40 seeds');
  });
});
