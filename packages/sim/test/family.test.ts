import { describe, expect, it } from 'vitest';
import { isMovementTrace } from '@vana/shared';
import { EventLog } from '../src/events/log.js';
import { buildGrid } from '../src/grid.js';
import { HYDRATION_EMERGENCY_THIRST, availableForCare, chooseCareTarget, finishCare, travelToFamily } from '../src/agents/family.js';
import { canFollowParent, careRadius, needsOf, provisionYoung } from '../src/agents/needs.js';
import { createWorld, SIM_VERSION } from '../src/world.js';
import { takeSnapshot, restoreSnapshot, upgradeV10Snapshot } from '../src/snapshot.js';
import { makeAgent, SPECIES_DIR, speciesOf } from './helpers.js';
import { asLegacySnapshot } from './legacySnapshot.js';

function fixture() {
  const cfg = structuredClone(speciesOf('dhole')), patches = buildGrid(1);
  cfg.locomotion.walkMs = 1;
  for (const p of patches) p.habitat = 'grassland';
  const parent = makeAgent('dhole', { id: 'mother', position: { x: -100, z: 0, heading: 0 },
    drives: { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 } });
  const child = makeAgent('dhole', { id: 'pup', dependentOn: parent.id, ageDays: 10, lifeStage: 'newborn',
    massKg: 2, position: { x: 0, z: 0, heading: 0 } });
  parent.offspringIds = [child.id];
  const starts = new Map([[child.id, { patchId: 0, position: { ...child.position! } }]]);
  const log = new EventLog(1, SIM_VERSION);
  const visit = (seconds: number) => travelToFamily(parent, cfg, patches, starts.get(child.id)!, 'care_for_young', 0, seconds / 3600, log);
  return { cfg, patches, parent, child, starts, log, visit };
}

describe('contact-based family care', () => {
  it('rejects same-patch remote, missing, invalid and nonfinite provisioning', () => {
    const s = fixture();
    expect(provisionYoung(s.parent, s.child, s.cfg, 1).foodEquivalentKg).toBe(0);
    s.parent.position = { ...s.child.position! };
    for (const hours of [0, -1, NaN, Infinity]) expect(provisionYoung(s.parent, s.child, s.cfg, hours).foodEquivalentKg).toBe(0);
    delete s.child.position;
    expect(provisionYoung(s.parent, s.child, s.cfg, 1).foodEquivalentKg).toBe(0);
    s.child.position = { x: NaN, z: 0, heading: 0 };
    expect(provisionYoung(s.parent, s.child, s.cfg, 1).foodEquivalentKg).toBe(0);
  });
  it('spends travel time before transferring and never relocates the waiting litter', () => {
    const s = fixture(), before = structuredClone(s.child);
    const visit = s.visit(10); finishCare(visit, [s.child], s.starts, s.cfg, 0, 10, s.log);
    expect(s.child).toEqual(before); expect(s.parent.position!.x).toBeGreaterThan(-100);
    expect(s.log.all().some(e => e.type === 'provisioned')).toBe(false);
    const trace = s.log.all()[0]!.movement!;
    expect(isMovementTrace(trace)).toBe(true); expect(trace.completed).toBe(false);
    expect(s.log.all()[0]!.effects.distanceM).toBeCloseTo(10);
  });
  it('requires positive contact time and records exact cost, coordinates and causal route', () => {
    const s = fixture(), visit = s.visit(3600), arrival = visit.arrival;
    finishCare(visit, [s.child], s.starts, s.cfg, 0, arrival, s.log);
    expect(s.log.all().filter(e => e.type === 'provisioned')).toHaveLength(0);
    finishCare(visit, [s.child], s.starts, s.cfg, 0, arrival + 1, s.log);
    const e = s.log.all().find(e => e.type === 'provisioned')!;
    expect(e.conditions.provisioningSeconds).toBeCloseTo(1);
    expect(e.effects.foodEquivalentKg).toBeCloseTo(needsOf(s.child, s.cfg).foodKg / 8 / 3600);
    expect(e.effects.waterEquivalentL).toBeCloseTo(needsOf(s.child, s.cfg).waterL / 8 / 3600);
    expect(e.causalParents).toEqual([visit.routeId]); expect(e.position).toEqual(s.child.position);
    expect(Math.hypot(s.parent.position!.x - e.position!.x, s.parent.position!.z - e.position!.z)).toBeLessThan(careRadius(s.cfg));
  });
  it.each(['dead_parent', 'dead_child', 'escape', 'child_moved', 'parent_moved', 'child_fled', 'orphan', 'weaned'])
    ('cannot finalize care after %s', (condition) => {
      const s = fixture(), visit = s.visit(3600), hunger = s.child.drives.hunger;
      if (condition === 'dead_parent') s.parent.alive = false;
      if (condition === 'dead_child') s.child.alive = false;
      if (condition === 'escape') s.child.lastEncounterAt = 0;
      if (condition === 'child_moved') s.child.position!.x += 0.1;
      if (condition === 'parent_moved') s.parent.position!.x += 100;
      if (condition === 'child_fled') s.child.state = 'fleeing';
      if (condition === 'orphan') s.child.dependentOn = null;
      if (condition === 'weaned') s.child.ageDays = s.cfg.lifecycle.weanDays;
      finishCare(visit, [s.child], s.starts, s.cfg, 0, 3600, s.log);
      expect(s.child.drives.hunger).toBe(hunger);
      expect(s.log.all().filter(e => e.type === 'provisioned')).toHaveLength(0);
    });
  it('supports a stationary visit without inventing an approach route, and does not overdraw a litter donor', () => {
    const s = fixture(); s.parent.position = { ...s.child.position! };
    const visit = s.visit(3600); expect(visit.routeId).toBeUndefined();
    const children = Array.from({ length: 80 }, (_, i) => ({ ...structuredClone(s.child), id: `pup-${i}` }));
    for (const child of children) s.starts.set(child.id, { patchId: 0, position: { ...child.position! } });
    finishCare(visit, children, s.starts, s.cfg, 0, 3600, s.log);
    expect(s.parent.drives.hunger).toBeLessThanOrEqual(0.8 + 1e-10);
    expect(s.parent.drives.thirst).toBeLessThanOrEqual(0.8 + 1e-10);
    expect(s.log.all().length).toBeGreaterThan(0);
    expect(s.log.all().every(e => e.type === 'provisioned' && e.causalParents.length === 0)).toBe(true);
  });
  it('keeps mother survival needs and danger ahead of repeated care, with stable sibling selection', () => {
    const s = fixture(), sibling = { ...s.child, id: 'a' };
    expect(chooseCareTarget(s.parent, [s.child, sibling], s.cfg)?.id).toBe('a');
    expect(chooseCareTarget(s.parent, [sibling, s.child], s.cfg)?.id).toBe('a');
    s.parent.drives.thirst = 0.9;
    expect(chooseCareTarget(s.parent, [s.child], s.cfg)).toBeUndefined();
  });
  it('lets hunger yield only to a dependent in a hydration emergency (sim_0.32.0)', () => {
    const s = fixture(), calm = { ...structuredClone(s.child), id: 'calm' };
    s.parent.drives.hunger = 0.85;
    s.child.drives.thirst = HYDRATION_EMERGENCY_THIRST; calm.drives.thirst = 0.45; calm.drives.hunger = 0.9;
    expect(availableForCare(s.parent)).toBe(false);
    expect(availableForCare(s.parent, calm)).toBe(false);
    expect(availableForCare(s.parent, s.child)).toBe(true);
    // The hungrier sibling is not chosen: a hungry parent answers thirst, not appetite.
    expect(chooseCareTarget(s.parent, [calm, s.child], s.cfg)?.id).toBe(s.child.id);
    expect(chooseCareTarget(s.parent, [calm], s.cfg)).toBeUndefined();
    // A thirsty or frightened parent has nothing safe to give, whatever the emergency.
    s.parent.drives.thirst = 0.65;
    expect(availableForCare(s.parent, s.child)).toBe(false);
    s.parent.drives.thirst = 0.1; s.parent.drives.fear = 0.5;
    expect(availableForCare(s.parent, s.child)).toBe(false);
    s.parent.drives.fear = 0;
    s.parent.alive = false;
    expect(availableForCare(s.parent, s.child)).toBe(false);
  });
  it('uses explicit species following ages without giving infant pups adult ground locomotion', () => {
    const s = fixture(); expect(canFollowParent(s.child, s.cfg)).toBe(false);
    const calf = makeAgent('elephant', { ageDays: 1 }); expect(canFollowParent(calf, speciesOf('elephant'))).toBe(true);
    const cub = makeAgent('tiger', { ageDays: 55 }); expect(canFollowParent(cub, speciesOf('tiger'))).toBe(false);
    cub.ageDays = 56; expect(canFollowParent(cub, speciesOf('tiger'))).toBe(true);
  });
});

describe('world family coordination', () => {
  const options = { seed: 5, speciesDir: SPECIES_DIR, initialAgents: { dhole: 2 }, minPopulation: {} };
  function family(reverse = false) {
    const world = createWorld(options), [parent, child] = world.agents;
    parent!.patchId = 0; parent!.position = { x: -100, z: 0, heading: 0 };
    parent!.sex = 'female'; parent!.pregnantSince = null; parent!.drives = { hunger: 0.2, thirst: 0.2, fear: 0, fatigue: 0 };
    parent!.offspringIds = [child!.id];
    Object.assign(child!, { dependentOn: parent!.id, motherId: parent!.id, ageDays: 10, lifeStage: 'newborn',
      massKg: 2, patchId: 0, position: { x: 100, z: 0, heading: 0 },
      drives: { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 } });
    if (reverse) world.agents.reverse();
    return { world, parent: parent!, child: child! };
  }
  it('births a compact litter and nurses every local pup after returning, without child relocation', () => {
    const world = createWorld({ ...options, initialAgents: { dhole: 1 } }), parent = world.agents[0]!;
    const cfg = world.species.get('dhole')!;
    parent.sex = 'female'; parent.pregnantSince = -cfg.lifecycle.gestationDays * 86400;
    parent.drives = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 };
    world.step(1);
    const pups = world.agents.filter(a => a.dependentOn === parent.id);
    expect(pups.length).toBeGreaterThanOrEqual(4);
    const starts = new Map(pups.map(p => [p.id, { patchId: p.patchId, position: { ...p.position! } }]));
    for (const child of pups) {
      expect(Math.hypot(child.position!.x - parent.position!.x, child.position!.z - parent.position!.z)).toBeLessThanOrEqual(careRadius(cfg) * 0.25 + 1e-8);
      child.drives.hunger = 0.3; child.drives.thirst = 0.3;
    }
    // A nearby departure within the same patch; returning must still cost real time.
    parent.position!.x += parent.position!.x % 300 < 0 ? 30 : -30;
    world.log.take(); world.step(1);
    const visits = world.log.all().filter(e => e.type === 'provisioned');
    expect(new Set(visits.map(e => e.actors[0]))).toEqual(new Set(pups.map(p => p.id)));
    for (const child of pups) expect(child.position).toEqual(starts.get(child.id)!.position);
    expect(visits.every(e => Number(e.conditions.arrivalWorldTime) > 3600)).toBe(true);
  });
  it.each([false, true])('approaches a stationary pup and gives only remaining-time care; child-first=%s', reverse => {
    const s = family(reverse), before = { ...s.child.position! }, nutrients = s.world.totalNutrients();
    s.world.step(1);
    expect(s.child.position).toEqual(before);
    const event = s.world.log.all().find(e => e.type === 'provisioned')!;
    expect(event).toBeDefined(); expect(event.conditions.arrivalWorldTime).toBeGreaterThan(0);
    expect(event.conditions.provisioningSeconds).toBeLessThan(3600);
    expect(event.worldTime).toBe(3600); expect(event.causalParents).toHaveLength(1);
    expect(s.world.totalNutrients()).toBeCloseTo(nutrients, 6);
    const restored = restoreSnapshot(takeSnapshot(s.world), options); s.world.log.take();
    for (let i = 0; i < 48; i++) { s.world.step(1); restored.step(1); }
    expect(restored.agents).toEqual(s.world.agents); expect(restored.log.all()).toEqual(s.world.log.all());
  });
  it('brings a hungry, watered mother back to a thirsty pup with water only, at her own cost (sim_0.32.0)', () => {
    for (const pupThirst of [0.3, 0.6]) {
      const s = family(); s.parent.drives = { hunger: 0.85, thirst: 0.1, fear: 0, fatigue: 0 };
      s.child.drives = { hunger: 0.4, thirst: pupThirst, fatigue: 0, fear: 0 };
      s.world.step(1);
      const given = s.world.log.all().filter(e => e.type === 'provisioned');
      if (pupThirst < HYDRATION_EMERGENCY_THIRST) { expect(given).toHaveLength(0); continue; }
      expect(given).toHaveLength(1);
      expect(given[0]!.actors).toEqual([s.child.id, s.parent.id]);
      expect(Number(given[0]!.effects.waterEquivalentL)).toBeGreaterThan(0);
      // Past the 0.8 donor ceiling she has no food to give; hunger only allowed the visit.
      expect(given[0]!.effects.foodEquivalentKg).toBe(0);
      expect(s.child.drives.hunger).toBeGreaterThan(0.4);
      const cfg = s.world.species.get('dhole')!;
      const drunk = Number(given[0]!.effects.waterEquivalentL) / needsOf(s.parent, cfg).waterL * 0.4;
      expect(s.parent.drives.thirst).toBeCloseTo(0.1 + 0.4 / 24 + drunk, 10);
    }
  });
  it('does not provision or jump when the parent cannot arrive in time', () => {
    const s = family(); s.world.species.get('dhole')!.locomotion.walkMs = 0.001;
    const before = { ...s.child.position! }; s.world.step(1);
    expect(s.child.position).toEqual(before);
    expect(s.world.log.all().some(e => e.type === 'provisioned')).toBe(false);
    expect(s.parent.journey?.goal).toBe('care_for_young');
  });
  it('follows a perceivable parent start point, not its later endpoint, with a real recorded route', () => {
    const world = createWorld({ ...options, initialAgents: { elephant: 2 } }), [parent, calf] = world.agents;
    parent!.sex = 'male'; parent!.patchId = 0; parent!.position = { x: 100, z: 0, heading: 0 };
    parent!.drives = { hunger: 0, thirst: 0.8, fear: 0, fatigue: 0 };
    Object.assign(calf!, { dependentOn: parent!.id, ageDays: 1, lifeStage: 'newborn', massKg: 100,
      patchId: 0, position: { x: -100, z: 0, heading: 0 }, drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
    const parentStart = { ...parent!.position! }; world.step(1);
    const movement = world.log.all().find(e => e.actors[0] === calf!.id && e.goal === 'follow_parent')!;
    expect(isMovementTrace(movement.movement)).toBe(true);
    expect(movement.conditions.targetX).toBe(parentStart.x);
    expect(parent!.position).not.toEqual(parentStart);
    expect(Math.hypot(calf!.position!.x - parentStart.x, calf!.position!.z - parentStart.z)).toBeLessThan(careRadius(world.species.get('elephant')!));
  });
  it('cannot teach a remote family member by ID alone, but permits a nearby observer', () => {
    for (const distant of [true, false]) {
      const world = createWorld({ ...options, initialAgents: { sambar: 2 } }), [parent, child] = world.agents;
      parent!.patchId = 0; parent!.position = { x: 0, z: 0, heading: 0 }; parent!.sex = 'male';
      parent!.drives = { hunger: 0.6, thirst: 0, fatigue: 0, fear: 0 }; parent!.offspringIds = [child!.id];
      Object.assign(child!, { dependentOn: parent!.id, motherId: parent!.id, ageDays: 200, lifeStage: 'juvenile',
        patchId: 0, position: { x: distant ? 100 : 1, z: 0, heading: 0 }, skills: {},
        drives: { hunger: 0, thirst: 0, fatigue: 1, fear: 0 } });
      world.step(1);
      expect(child!.skills?.forage_efficiency?.taughtBy ?? null).toBe(distant ? null : parent!.id);
    }
  });
  it('requires a source-specific explicit v0.10 upgrade and does not edit old positions/history', () => {
    const s = family(), old = asLegacySnapshot(takeSnapshot(s.world), 'sim_0.10.0'), before = JSON.stringify(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV10Snapshot(old); expect(upgraded.simVersion).toBe(SIM_VERSION);
    expect(restoreSnapshot(upgraded, options).agents).toEqual(s.world.agents);
    expect(JSON.stringify(old)).toBe(before);
    expect(() => upgradeV10Snapshot({ ...old, simVersion: 'sim_0.9.0' })).toThrow();
  });
});
