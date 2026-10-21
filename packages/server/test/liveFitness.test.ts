import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ISLAND_GRID, fitnessEffects, fitnessOf, landWalkable, patchCentre } from '@vana/shared';
import { createWorld, type World } from '@vana/sim';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

/** A tiger and a chital on open land (as in liveHunting), each kept as the test says. */
function setup(random: () => number) {
  const world: World = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1',
    initialAgents: { tiger: 2, chital: 12 }, minPopulation: {} });
  const open = world.patches.find((p) => landWalkable(p) && p.neighbours.every((n) => landWalkable(world.patches[n])))!;
  const centre = patchCentre(ISLAND_GRID, open.id);
  let now = 5_000_000;
  const live = new LiveLayer(worldPort(() => world, () => 'w'), null, () => now, random);
  const put = (id: string, dx: number) => { const a = world.animal(id)!; a.patchId = open.id; a.position = { x: centre.x + dx, z: centre.z, heading: 0 }; };
  const keep = (id: string, need: number) => { Object.assign(world.animal(id)!.drives, { hunger: need, thirst: need, fatigue: need }); };
  const run = (seconds: number) => { for (let i = 0; i < seconds * 10; i++) { now += 100; live.tick(0.1); } };
  const adult = (species: string) => world.agents.find((a) => a.alive && a.speciesId === species && a.lifeStage === 'adult'
    && a.dependentOn === null && !world.agents.some((c) => c.alive && c.dependentOn === a.id))!;
  return { world, live, put, keep, run, adult, centre };
}

// An agent that keeps its animal fed, watered and rested outruns and outhunts one that does not.
describe('fitness in live play', () => {
  it('a well-kept animal covers more ground than a neglected one, by its fitness', () => {
    const covered = (need: number) => {
      const { world, live, put, keep, run, adult, centre } = setup(() => 0);
      const tiger = adult('tiger');
      put(tiger.id, 0); keep(tiger.id, need);
      live.possess('ag_t', 'Stripe', { animalId: tiger.id });
      expect(live.moveTo('ag_t', [{ x: centre.x + 400, z: centre.z }], 'walk')).toBeNull();
      run(10);
      return { metres: live.avatars.get('ag_t')!.x - centre.x, fitness: fitnessOf({ drives: world.animal(tiger.id)!.drives }).score };
    };
    const kept = covered(0), neglected = covered(0.9);
    expect(kept.fitness).toBe(1);
    expect(neglected.fitness).toBeLessThan(0.35);
    expect(kept.metres / neglected.metres).toBeCloseTo(fitnessEffects(kept.fitness).speed / fitnessEffects(neglected.fitness).speed, 1);
    expect(kept.metres).toBeGreaterThan(neglected.metres * 1.15);
  });

  it('a fit hunter catches a weak prey that a weak hunter loses to a fit one, at the same luck', () => {
    // The luck drawn is between the two odds: the fit hunter's beats it, the weak one's does not.
    const base = 0.53 * (1.4 - 0.7 * 0.8);
    const fit = fitnessEffects(1), weak = fitnessEffects(fitnessOf({ drives: { hunger: 0.9, thirst: 0.9, fatigue: 0.9 } }).score);
    const strong = Math.min(0.9, base * fit.grip * weak.dodge), poor = Math.max(0.1, base * weak.grip * fit.dodge);
    expect(strong).toBeGreaterThan(base); expect(poor).toBeLessThan(base);
    const luck = (strong + poor) / 2;
    const hunt = (hunterNeed: number, preyNeed: number) => {
      const { world, live, put, keep, run, adult } = setup(() => luck);
      const tiger = adult('tiger'), chital = adult('chital');
      put(tiger.id, 0); put(chital.id, 6); keep(tiger.id, hunterNeed); keep(chital.id, preyNeed);
      live.possess('ag_t', 'Stripe', { animalId: tiger.id });
      expect(live.hunt('ag_t', chital.id)).toBeNull();
      run(8);
      return world.animal(chital.id)!.alive ? 'escaped' : 'caught';
    };
    expect(hunt(0, 0.9)).toBe('caught');
    expect(hunt(0.9, 0)).toBe('escaped');
  });
});
