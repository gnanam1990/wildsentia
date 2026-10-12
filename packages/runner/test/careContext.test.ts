import { describe, expect, it } from 'vitest';
import type { Agent, WorldEvent } from '@vana/shared';
import { CARE_FEAR_BLOCK, HUNGER_DESPERATION } from '@vana/sim';
import { CARE_WINDOW_HOURS, ECOLOGICAL_HOURS, ParentCareHistory, ecologicalReason } from '../src/careContext.js';
import { emptySoakYear, recordYearEvent, type ParentLookup } from '../src/yearMetrics.js';
import { ecologicalTally, gatedYoungThirst } from '../src/soak.js';

/** A minimal living animal: only the recorded state the classification reads. */
const animal = (id: string, species: string, extra: Partial<Agent> = {}): Agent => ({
  id, speciesId: species, alive: true, dependentOn: null, currentGoal: 'rest',
  drives: { hunger: 0.2, thirst: 0.1, fatigue: 0, fear: 0 }, ...extra } as Agent);

/** A dependent's thirst death 900 m from its mother, as the world records it. */
const thirstDeath = (child: Agent): WorldEvent => ({
  type: 'died', worldTime: 3600 * CARE_WINDOW_HOURS, simVersion: 'x', patchId: 4, position: { x: 0, z: 0 },
  actors: [child.id], conditions: { cause: 'dehydration', careState: 'unweaned_with_parent', lifeStage: 'newborn',
    species: child.speciesId, ageDays: 7 }, outcome: 'success', effects: {}, causalParents: [],
  confidence: 'authoritative' }) as WorldEvent;

/** Run 48 hours with the mother's drives set by `hour`, then her young dies of thirst out of reach. */
function scenario(species: string, mother: (hour: number) => Partial<Agent>) {
  const parent = animal(`${species}_mother`, species);
  const young = animal(`${species}_young`, species, { dependentOn: parent.id });
  const history = new ParentCareHistory();
  for (let hour = 0; hour < CARE_WINDOW_HOURS; hour++) {
    Object.assign(parent, mother(hour));
    history.sample([parent, young], hour);
  }
  const lookup: ParentLookup = {
    dependentOn: () => parent.id,
    locate: () => ({ patchId: 9, position: { x: 900, z: 0 } }),
    careRadiusM: () => 1.1,
    care: (id) => history.summary(id),
  };
  return recordYearEvent(emptySoakYear(1, 0), thirstDeath(young), lookup)!;
}

describe('ecological thirst deaths beside a living parent (sim_0.37.0)', () => {
  it('uses the model\'s own starvation and care-fear thresholds', () => {
    expect(HUNGER_DESPERATION).toBe(0.8);
    expect(CARE_FEAR_BLOCK).toBe(0.5);
    expect(ECOLOGICAL_HOURS).toBe(12);
  });

  it('reports a famished sow\'s litter, and does not gate it', () => {
    // Dry-season famine: the sow is starving in 30 of 48 hours and forages far from the nest.
    const record = scenario('boar', hour => ({ drives: { hunger: hour % 8 < 5 ? 0.86 : 0.76, thirst: 0.4, fatigue: 0, fear: 0 },
      currentGoal: 'find_food' }));
    expect(record).toMatchObject({ contact: 'remote', ecological: 'famine' });
    expect(record.parentCare).toMatchObject({ hours: 48, starvingHours: 30, threatHours: 0 });
    expect(gatedYoungThirst([record])).toEqual([]);
    expect(ecologicalTally([record])).toEqual({ 'boar/famine': 1 });
  });

  it('reports a fawn whose mother a predator kept away, and does not gate it', () => {
    // A dhole pack stays by the fawn: the doe is frightened or fleeing in 25 of 48 hours.
    const record = scenario('chital', hour => hour % 2 === 0 || hour < 2
      ? { drives: { hunger: 0.1, thirst: 0.05, fatigue: 0, fear: 0.7 }, currentGoal: 'flee' }
      : { drives: { hunger: 0.1, thirst: 0.05, fatigue: 0, fear: 0.1 }, currentGoal: 'find_food' });
    expect(record).toMatchObject({ contact: 'remote', ecological: 'predator' });
    expect(record.parentCare!.threatHours).toBe(25);
    expect(gatedYoungThirst([record])).toEqual([]);
    expect(ecologicalTally([record])).toEqual({ 'chital/predator': 1 });
  });

  it('still fails the gate when a well-fed, unthreatened mother is out of reach', () => {
    const record = scenario('chital', () => ({ drives: { hunger: 0.3, thirst: 0.1, fatigue: 0, fear: 0 }, currentGoal: 'wander' }));
    expect(record).toMatchObject({ contact: 'remote', ecological: null });
    expect(gatedYoungThirst([record])).toEqual([record]);
    expect(ecologicalTally([record])).toEqual({});
    // Just short of either threshold is still a care failure.
    const brief = scenario('boar', hour => ({ drives: { hunger: hour < ECOLOGICAL_HOURS - 1 ? 0.9 : 0.5, thirst: 0.1, fatigue: 0,
      fear: hour >= 20 && hour < 20 + ECOLOGICAL_HOURS - 1 ? 0.6 : 0 }, currentGoal: 'find_food' }));
    expect(brief.ecological).toBeNull();
    expect(gatedYoungThirst([brief])).toEqual([brief]);
  });

  it('classifies from recorded state only: drives and goal sampled each hour, nothing inferred', () => {
    const parent = animal('p', 'boar'), young = animal('y', 'boar', { dependentOn: 'p' }), lone = animal('l', 'boar');
    const history = new ParentCareHistory();
    parent.drives.hunger = HUNGER_DESPERATION;
    lone.drives.hunger = 1;
    history.sample([parent, young, lone], 0);
    // Changing her state afterwards does not rewrite what was recorded.
    parent.drives.hunger = 0;
    expect(history.summary('p')).toEqual({ hours: 1, starvingHours: 1, threatHours: 0, starvingAtLastSample: true });
    // Only parents of a living dependent are sampled.
    expect(history.summary('l')).toBeNull();
    // Fleeing counts as threatened whatever its fear; a dead dependent no longer makes a parent.
    parent.currentGoal = 'flee'; parent.drives.fear = 0.1;
    history.sample([parent, young], 1);
    expect(history.summary('p')!.threatHours).toBe(1);
    young.alive = false;
    history.sample([parent, young], 2);
    expect(history.summary('p')!.hours).toBe(2);
    // A death with no sampled history cannot be classified ecological: it is gated.
    expect(ecologicalReason(null)).toBeNull();
    // The window holds the last 48 hours only.
    young.alive = true;
    for (let h = 3; h < 3 + CARE_WINDOW_HOURS; h++) history.sample([parent, young], h);
    expect(history.summary('p')!.hours).toBe(CARE_WINDOW_HOURS);
  });
});
