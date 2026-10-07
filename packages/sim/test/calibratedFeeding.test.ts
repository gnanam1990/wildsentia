import { describe, expect, it } from 'vitest';
import { createRng, patchCentre } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { creditMeal, digestGut, gutCapacityKg, mealRoom, needsOf } from '../src/agents/needs.js';
import { selectGoal } from '../src/agents/goals.js';
import { perceive } from '../src/agents/perception.js';
import { restoreSnapshot, takeSnapshot, upgradeV34Snapshot } from '../src/snapshot.js';
import { SPECIES_DIR, makeAgent, speciesOf } from './helpers.js';

const tiger = speciesOf('tiger');

describe('predator feeding calibrated to field intake (sim_0.35.0)', () => {
  it('fills the day\'s hunger, then a stomach of 14% of body mass, and no more', () => {
    const t = makeAgent('tiger', { drives: { hunger: 0.35, thirst: 0, fatigue: 0, fear: 0 } });
    const daily = needsOf(t, tiger).foodKg;
    expect(gutCapacityKg(t, tiger)).toBeCloseTo(190 * 0.14);
    const room = mealRoom(t, tiger);
    expect(room).toBeCloseTo(0.35 / 0.14 * daily + 190 * 0.14);
    creditMeal(t, tiger, 100);
    expect(t.drives.hunger).toBe(0);
    expect(t.gutKg).toBeCloseTo(190 * 0.14);
    // Herbivores have no stomach store: grazing is unchanged.
    expect(gutCapacityKg(makeAgent('chital'), speciesOf('chital'))).toBe(0);
  });

  it('digests the stomach at the daily intake rate, holding hunger off for the days it covers', () => {
    const t = makeAgent('tiger', { drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
    const daily = needsOf(t, tiger).foodKg;
    t.gutKg = 2 * daily;
    for (let h = 0; h < 48; h++) { t.drives.hunger += 0.14 / 24; digestGut(t, tiger, 1); }
    expect(t.drives.hunger).toBeCloseTo(0, 9);
    expect(t.gutKg).toBeUndefined();
    t.drives.hunger += 0.14 / 24; digestGut(t, tiger, 1);
    expect(t.drives.hunger).toBeCloseTo(0.14 / 24, 9);
  });

  it('does not start a hunt while sated or below its hunting hunger, and does above it', () => {
    const world = createWorld({ seed: 4, speciesDir: SPECIES_DIR, initialAgents: { tiger: 1, chital: 6 }, minPopulation: {} });
    const t = world.agents.find(a => a.speciesId === 'tiger')!;
    for (const a of world.agents) { a.patchId = 210; a.position = { ...patchCentre(210), heading: 0 }; }
    t.position = { ...patchCentre(210), x: patchCentre(210).x + 100, heading: 0 };
    world.__reindexForTest();
    const goal = (hunger: number, gutKg?: number) => {
      t.drives = { hunger, thirst: 0, fatigue: 0, fear: 0 };
      if (gutKg === undefined) delete t.gutKg; else t.gutKg = gutKg;
      const p = perceive(t, tiger, world.__viewForTest());
      expect(p.prey.length).toBeGreaterThan(0);
      return selectGoal(t, tiger, p, createRng(7, 'goal')).goal;
    };
    expect(goal(0.3)).not.toBe('hunt');
    expect(goal(0.6, 5)).not.toBe('hunt');
    expect(goal(0.6)).toBe('hunt');
  });

  it('a lone tiger among plentiful deer kills about once a week, not daily', () => {
    const world = createWorld({ seed: 4, speciesDir: SPECIES_DIR, initialAgents: { tiger: 1, chital: 300, sambar: 80 }, minPopulation: {} });
    const t = world.agents.find(a => a.speciesId === 'tiger')!;
    let kills = 0, hours = 0;
    for (let h = 0; h < 90 * 24; h++) {
      world.step(1);
      for (const e of world.log.take()) if (e.type === 'hunt' && e.outcome === 'success' && e.actors[0] === t.id) kills++;
      if (!t.alive) break;
      hours++;
    }
    // Karanth & Sunquist: about one large kill every 7-8 days, some 50 a year. This 36 km² grid
    // holds only 8 chital per km², and a lone tiger on it can starve within a few months (the
    // ecology doc, sim_0.36.0); sim_0.37.0's other rule changes reshuffled this seed's history so
    // that it does by day 63. The rate is measured over the days it lived, at least six weeks.
    expect(hours / 24).toBeGreaterThanOrEqual(45);
    const perNinetyDays = kills * 90 * 24 / hours;
    expect(perNinetyDays).toBeGreaterThanOrEqual(6);
    expect(perNinetyDays).toBeLessThanOrEqual(20);
  });

  it('checkpoints the stomach, rejects an impossible one, and opts a v0.34 world in unchanged', () => {
    const options = { seed: 4, speciesDir: SPECIES_DIR, initialAgents: { tiger: 1 }, minPopulation: {} };
    const world = createWorld(options);
    world.agents[0]!.gutKg = 10;
    const saved = JSON.parse(JSON.stringify(takeSnapshot(world)));
    expect(restoreSnapshot(saved, options).agents[0]!.gutKg).toBe(10);
    const broken = structuredClone(saved); broken.agents[0].gutKg = 999;
    expect(() => restoreSnapshot(broken, options)).toThrow(/stomach/);
    const current = takeSnapshot(createWorld(options));
    const old = structuredClone(current); old.simVersion = 'sim_0.34.0';
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    expect(upgradeV34Snapshot(old)).toEqual(current);
    expect(() => upgradeV34Snapshot(current)).toThrow(/only sim_0.34.0/);
  });
});
