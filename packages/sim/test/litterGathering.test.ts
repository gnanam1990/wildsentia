import { describe, expect, it } from 'vitest';
import { createRng, patchCentre, waterAccessPosition, type Agent } from '@vana/shared';
import { executeGoal } from '../src/agents/behaviours.js';
import { perceive } from '../src/agents/perception.js';
import { selectGoal } from '../src/agents/goals.js';
import { buildGrid } from '../src/grid.js';
import { makeServices, makeView } from './helpers.js';
import { canFollowParent, canGatherToParent, careRadius } from '../src/agents/needs.js';
import { finishCare, type FamilyLocation } from '../src/agents/family.js';
import { EventLog } from '../src/events/log.js';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot, upgradeV35Snapshot } from '../src/snapshot.js';
import { makeAgent, SPECIES_DIR, speciesOf } from './helpers.js';

/**
 * sim_0.36.0: a litter gathers to its parent's care point. Island traces found piglets and pups
 * scattered 6-45 m apart in one patch while their mother, beside them all day, reached one spot
 * an hour and each young died of thirst between visits.
 */
function litterWorld(speciesId: 'boar' | 'jackal', ageDays: number) {
  const cfg = speciesOf(speciesId);
  const world = createWorld({ seed: 2, speciesDir: SPECIES_DIR, initialAgents: { [speciesId]: 3 }, minPopulation: {} });
  const [mother, target, sibling] = world.agents as [Agent, Agent, Agent];
  mother.sex = 'female'; mother.drives = { hunger: 0.2, thirst: 0.1, fatigue: 0, fear: 0 };
  const base = { ...waterAccessPosition(target.patchId), x: waterAccessPosition(target.patchId).x + 60 };
  for (const child of [target, sibling]) {
    Object.assign(child, makeAgent(speciesId, { id: child.id, ageDays, lifeStage: 'newborn', motherId: mother.id,
      dependentOn: mother.id, massKg: cfg.body.adultMassKg * 0.12, patchId: target.patchId, groupId: mother.groupId,
      drives: { hunger: 0.3, thirst: child === target ? 0.8 : 0.6, fatigue: 0, fear: 0 } }));
  }
  target.position = { ...base }; sibling.position = { ...base, x: base.x + 25 };
  mother.offspringIds = [target.id, sibling.id];
  mother.patchId = target.patchId; mother.position = { ...base, x: base.x - 20 };
  world.__reindexForTest();
  return { world, cfg, mother, target, sibling };
}

describe('a litter gathers to its parent (sim_0.36.0)', () => {
  it('sets the gathering ages from the field: piglets from birth, jackal pups once their eyes open, dhole pups at three weeks', () => {
    const boar = speciesOf('boar'), jackal = speciesOf('jackal'), dhole = speciesOf('dhole');
    expect(canGatherToParent(makeAgent('boar', { ageDays: 0 }), boar)).toBe(true);
    expect(canFollowParent(makeAgent('boar', { ageDays: 5 }), boar)).toBe(false);
    expect(canGatherToParent(makeAgent('jackal', { ageDays: 9.9 }), jackal)).toBe(false);
    expect(canGatherToParent(makeAgent('jackal', { ageDays: 10 }), jackal)).toBe(true);
    expect(canGatherToParent(makeAgent('dhole', { ageDays: 20 }), dhole)).toBe(false);
    expect(canGatherToParent(makeAgent('dhole', { ageDays: 21 }), dhole)).toBe(true);
    // Species without a gathering age do not gather: their follow rules alone apply.
    const tiger = speciesOf('tiger');
    expect(canGatherToParent(makeAgent('tiger', { ageDays: tiger.lifecycle.weanDays - 1 }), tiger)).toBe(false);
  });

  it.each([['boar', 5], ['jackal', 18]] as const)('a %s %i days old walks to the sibling its mother is feeding and is fed with it', (speciesId, age) => {
    const { world, cfg, mother, target, sibling } = litterWorld(speciesId, age);
    const origin = { ...sibling.position! };
    world.step(1);
    const walk = world.log.all().find(e => e.type === 'moved' && e.actors[0] === sibling.id && e.goal === 'follow_parent');
    expect(walk?.movement?.completed).toBe(true);
    expect(sibling.position).not.toEqual(origin);
    const fed = world.log.all().filter(e => e.type === 'provisioned');
    expect(fed.map(e => e.actors[0]).sort()).toEqual([sibling.id, target.id].sort());
    expect(fed.find(e => e.actors[0] === sibling.id)!.causalParents).toContain(walk!.id);
    expect(Math.hypot(sibling.position!.x - mother.position!.x, sibling.position!.z - mother.position!.z))
      .toBeLessThanOrEqual(careRadius(cfg) + 1e-8);
  });

  it('a pup too young to walk stays where it lies, and a frightened one hides instead of coming', () => {
    const young = litterWorld('jackal', 6);
    const origin = { ...young.sibling.position! };
    young.world.step(1);
    expect(young.sibling.position).toEqual(origin);
    expect(young.world.log.all().some(e => e.type === 'provisioned' && e.actors[0] === young.sibling.id)).toBe(false);

    const scared = litterWorld('boar', 5);
    scared.sibling.drives.fear = 1; // still 0.58 after the hour's decay
    const start = { ...scared.sibling.position! };
    scared.world.step(1);
    expect(scared.sibling.position).toEqual(start);
  });
});

describe('a denned pup that cannot yet walk does not run from an attack (sim_0.36.0)', () => {
  const escapes = (ageDays: number): number[] => {
    const moved: number[] = [];
    for (let seed = 1; seed <= 80; seed++) {
      const patches = buildGrid(11), centre = patchCentre(210);
      const hunter = makeAgent('dhole', { id: 'hunter', patchId: 210, position: { x: centre.x - 40, z: centre.z, heading: 0 },
        drives: { hunger: 0.9, thirst: 0, fatigue: 0, fear: 0 } });
      const pup = makeAgent('jackal', { id: 'pup', ageDays, lifeStage: 'newborn', massKg: 9 * 0.12, patchId: 210,
        position: { x: centre.x, z: centre.z, heading: 0 }, drives: { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 } });
      const view = makeView(patches, [hunter, pup]), log = new EventLog(seed, 'test');
      executeGoal({ agent: hunter, species: speciesOf('dhole'), patches, view, percept: perceive(hunter, speciesOf('dhole'), view),
        choice: { goal: 'hunt', score: 1, alternative: null }, hours: 1, worldTime: 0, log, rng: createRng(seed, 'pup-hunt'),
        services: makeServices([]) });
      const hunt = log.all().find(e => e.type === 'hunt');
      if (!pup.alive || !hunt?.encounter?.samples.some(x => x.phase === 'escape')) continue;
      moved.push(Math.hypot(pup.position!.x - centre.x, pup.position!.z - centre.z));
    }
    return moved;
  };
  it('a six-day-old pup that survives an attack is still where it lay; a weaned one runs', () => {
    const young = escapes(6), older = escapes(70);
    expect(young.length).toBeGreaterThan(0);
    expect(Math.max(...young)).toBeLessThan(1);
    expect(Math.max(...older)).toBeGreaterThan(5);
  });
});

describe('a young that can follow moves off from a predator at its flight distance (sim_0.36.0)', () => {
  it('a three-month fawn steps away from a tiger resting 30 m off; a ten-day hider lies still', () => {
    const patches = buildGrid(11), centre = patchCentre(210), chital = speciesOf('chital');
    const tiger = makeAgent('tiger', { id: 'tiger', patchId: 210, state: 'resting', currentGoal: 'rest',
      position: { x: centre.x + 30, z: centre.z, heading: 0 } });
    const goalAt = (ageDays: number) => {
      const fawn = makeAgent('chital', { id: 'fawn', ageDays, lifeStage: 'juvenile', dependentOn: 'doe', massKg: 20,
        patchId: 210, position: { ...centre, heading: 0 }, drives: { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 } });
      const percept = perceive(fawn, chital, makeView(patches, [fawn, tiger]));
      expect(percept.threat?.fear).toBe(0.5);
      fawn.drives.fear = percept.threat!.fear;
      return selectGoal(fawn, chital, percept, createRng(1, 'fawn')).goal;
    };
    expect(goalAt(90)).toBe('flee');
    expect(goalAt(10)).toBe('rest');
  });
});

describe('a once-daily nursing feed is taken to repletion (sim_0.36.0)', () => {
  it('restores a leveret two days short of milk in one feed, bounded by the doe\'s reserves', () => {
    const hare = speciesOf('hare');
    const doe = makeAgent('hare', { id: 'doe', patchId: 5, drives: { hunger: 0.1, thirst: 0.05, fatigue: 0, fear: 0 } });
    const leveret = makeAgent('hare', { id: 'lev', ageDays: 3, lifeStage: 'newborn', dependentOn: 'doe', motherId: 'doe',
      massKg: 2.5 * 0.12, patchId: 5, drives: { hunger: 0.3, thirst: 0.8, fatigue: 0, fear: 0 } });
    doe.position = { ...waterAccessPosition(5) }; leveret.position = { ...doe.position };
    doe.offspringIds = [leveret.id]; doe.currentGoal = 'care_for_young';
    const nineteen = 19 * 3600;
    const starts = new Map<string, FamilyLocation>([[leveret.id, { patchId: 5, position: { ...leveret.position } }]]);
    const served = finishCare({ parent: doe, arrival: nineteen, position: { ...doe.position } }, [leveret], starts, hare,
      nineteen, nineteen + 3600, new EventLog(1, 'test'));
    expect(served).toEqual([leveret.id]);
    // Capped at a day's ration (0.4 thirst) it would have left at 0.4 and died after one more missed feed.
    expect(leveret.drives.thirst).toBeCloseTo(0, 9);
    expect(leveret.nursingIntake!.waterDays).toBeCloseTo(2, 6);
    expect(leveret.nursingIntake!.contactSeconds).toBeLessThanOrEqual(hare.lifecycle.nursing!.dailyContactSeconds);
    expect(doe.drives.thirst).toBeGreaterThan(0.05);

    // A parched doe gives no more than her own reserves above the donor ceiling.
    const dry = makeAgent('hare', { id: 'doe2', patchId: 5, drives: { hunger: 0.1, thirst: 0.75, fatigue: 0, fear: 0 } });
    const lev2 = { ...leveret, id: 'lev2', dependentOn: 'doe2', drives: { hunger: 0.3, thirst: 0.8, fatigue: 0, fear: 0 } };
    delete lev2.nursingIntake;
    dry.position = { ...leveret.position! }; dry.currentGoal = 'care_for_young';
    finishCare({ parent: dry, arrival: nineteen, position: { ...dry.position } }, [lev2], new Map([[lev2.id, starts.get(leveret.id)!]]),
      hare, nineteen, nineteen + 3600, new EventLog(1, 'test'));
    expect(dry.drives.thirst).toBeCloseTo(0.8, 9);
    expect(lev2.drives.thirst).toBeGreaterThan(0.5);
  });
});

describe('leverets suckle at birth (sim_0.36.0)', () => {
  it('a doe feeds her new litter from her own reserves before leaving it', () => {
    const world = createWorld({ seed: 6, speciesDir: SPECIES_DIR, initialAgents: { hare: 1 }, minPopulation: {} });
    const doe = world.agents[0]!;
    doe.sex = 'female'; doe.drives = { hunger: 0.1, thirst: 0.1, fatigue: 0, fear: 0 };
    doe.pregnantSince = -speciesOf('hare').lifecycle.gestationDays * 86400;
    world.step(1);
    const born = world.log.all().filter(e => e.type === 'born');
    expect(born.length).toBeGreaterThan(0);
    for (const e of born) {
      expect(Number(e.effects.firstFeedWaterL)).toBeGreaterThan(0);
      const leveret = world.agents.find(a => a.id === e.actors[0])!;
      expect(leveret.drives.thirst).toBeLessThan(0.05);
    }
    expect(doe.drives.thirst).toBeGreaterThan(0.1);
  });
});

describe('sim_0.36.0 upgrade', () => {
  it('opts a saved v0.35 world in unchanged and refuses it without the upgrade', () => {
    const options = { seed: 4, speciesDir: SPECIES_DIR, initialAgents: { boar: 3, dhole: 4 }, minPopulation: {} };
    const current = takeSnapshot(createWorld(options));
    expect(current.simVersion).toBe('sim_0.36.0');
    const old = structuredClone(current); old.simVersion = 'sim_0.35.0';
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    expect(upgradeV35Snapshot(old)).toEqual(current);
    expect(() => upgradeV35Snapshot(current)).toThrow(/only sim_0.35.0/);
  });
});
