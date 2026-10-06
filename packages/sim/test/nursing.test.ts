import { describe, expect, it } from 'vitest';
import { isMovementTrace } from '@vana/shared';
import { EventLog } from '../src/events/log.js';
import { buildGrid } from '../src/grid.js';
import { chooseCareTarget, finishCare, travelToFamily } from '../src/agents/family.js';
import { establishNursingSites, nursingBudget, nursingEligible, nursingWindow } from '../src/agents/nursing.js';
import { careRadius, needsOf } from '../src/agents/needs.js';
import { HUNGER_PER_DAY, THIRST_PER_DAY } from '../src/agents/drives.js';
import { parseSpecies } from '../src/config/loader.js';
import { createWorld, SIM_VERSION } from '../src/world.js';
import { takeSnapshot, restoreSnapshot, upgradeV11Snapshot } from '../src/snapshot.js';
import { makeAgent, SPECIES_DIR, speciesOf } from './helpers.js';
import { asLegacySnapshot } from './legacySnapshot.js';

const hour = 3600, start = 19 * hour;
function fixture() {
  const cfg = structuredClone(speciesOf('hare')), patches = buildGrid(1);
  for (const p of patches) p.habitat = 'grassland';
  const parent = makeAgent('hare', { id: 'mother', position: { x: -50, z: 0, heading: 0 },
    drives: { hunger: 0.05, thirst: 0.05, fatigue: 0, fear: 0 } });
  const child = makeAgent('hare', { id: 'young', dependentOn: parent.id, ageDays: 5, lifeStage: 'newborn',
    massKg: 0.3, position: { x: 100, z: 0, heading: 0 },
    drives: { hunger: 0.6, thirst: 0.6, fatigue: 0, fear: 0 },
    nursingSite: { patchId: 0, position: { x: 0, z: 0, heading: 0 }, establishedAt: 0, origin: 'birth' } });
  parent.offspringIds = [child.id];
  const starts = new Map([[child.id, { patchId: child.patchId, position: { ...child.position! } }]]);
  const log = new EventLog(1, SIM_VERSION);
  const parentVisit = travelToFamily(parent, cfg, patches, child.nursingSite!, 'care_for_young', start, 1, log);
  const childVisit = travelToFamily(child, cfg, patches, child.nursingSite!, 'seek_nursing', start, 1, log);
  const arrivals = new Map([[child.id, childVisit]]);
  const finish = (end = start + hour) => finishCare(parentVisit, [child], starts, cfg, start, end, log, arrivals);
  return { cfg, parent, child, log, parentVisit, childVisit, finish, starts, arrivals };
}

describe('daily nursing policy', () => {
  it('intersects only the configured window, including boundaries and next-day reset', () => {
    const cfg = speciesOf('hare');
    expect(nursingWindow(cfg, 18 * hour, start)).toBeNull();
    expect(nursingWindow(cfg, start, 20 * hour)).toEqual({ cycle: 0, start, end: 20 * hour });
    expect(nursingWindow(cfg, 22.5 * hour, 24 * hour)).toEqual({ cycle: 0, start: 22.5 * hour, end: 23 * hour });
    expect(nursingWindow(cfg, 23 * hour, 25 * hour)).toBeNull();
    expect(nursingWindow(cfg, 23 * hour, 44 * hour)).toEqual({ cycle: 1, start: 43 * hour, end: 44 * hour });
    for (const [a, b] of [[NaN, 2], [0, Infinity], [2, 1], [2, 2]]) expect(nursingWindow(cfg, a!, b!)).toBeNull();
    expect(nursingWindow(speciesOf('dhole'), start, start + hour)).toBeNull();
  });
  it.each([
    { startHour: 24 }, { startHour: -1 }, { startHour: 22, windowHours: 4 },
    { windowHours: 0 }, { dailyContactSeconds: 0 }, { dailyContactSeconds: 3601 }, { locomotionFromDays: -1 },
  ])('rejects invalid nursing configuration %j', bad => {
    const cfg = structuredClone(speciesOf('hare'));
    Object.assign(cfg.lifecycle.nursing!, bad);
    expect(() => parseSpecies(cfg)).toThrow();
  });
  it('waits for both independent arrivals and debits the exact donor reserve', () => {
    const s = fixture(), before = structuredClone(s.parent.drives);
    expect(s.childVisit.arrival).toBeGreaterThan(s.parentVisit.arrival);
    s.finish(s.childVisit.arrival);
    expect(s.log.all().filter(e => e.type === 'provisioned')).toHaveLength(0);
    s.finish(s.childVisit.arrival + 60);
    const event = s.log.all().find(e => e.type === 'provisioned')!;
    expect(event.conditions.arrivalWorldTime).toBe(s.childVisit.arrival);
    expect(event.conditions.provisioningSeconds).toBe(60);
    expect(event.causalParents).toEqual([s.parentVisit.routeId, s.childVisit.routeId]);
    // sim_0.36.0: a full 300 s bout can replace 2.5 days (the whole deficit a young can carry).
    expect(event.effects.foodEquivalentKg).toBeCloseTo(needsOf(s.child, s.cfg).foodKg / 2);
    expect(event.effects.waterEquivalentL).toBeCloseTo(needsOf(s.child, s.cfg).waterL / 2);
    expect(s.parent.drives.hunger - before.hunger).toBeCloseTo(Number(event.effects.foodEquivalentKg) / needsOf(s.parent, s.cfg).foodKg * HUNGER_PER_DAY);
    expect(s.parent.drives.thirst - before.thirst).toBeCloseTo(Number(event.effects.waterEquivalentL) / needsOf(s.parent, s.cfg).waterL * THIRST_PER_DAY);
    expect(s.child.nursingIntake).toMatchObject({ cycle: 0, contactSeconds: 60, completed: false });
    expect(s.child.nursingIntake!.foodDays).toBeCloseTo(0.5, 12);
    expect(s.child.nursingIntake!.waterDays).toBeCloseTo(0.5, 12);
  });
  it('resumes a partial bout without overlapping time, feeds to repletion, and never refills on retry', () => {
    const s = fixture(); s.finish(s.childVisit.arrival + 60);
    const first = structuredClone(s.child);
    s.finish(s.childVisit.arrival + 60); expect(s.child).toEqual(first);
    s.finish();
    const events = s.log.all().filter(e => e.type === 'provisioned');
    expect(events).toHaveLength(2);
    expect(events[1]!.conditions.arrivalWorldTime).toBe(s.childVisit.arrival + 60);
    expect(events[1]!.conditions.provisioningSeconds).toBe(240);
    expect(s.child.nursingIntake).toMatchObject({ contactSeconds: 300, completed: true });
    // Thirst 0.6 is 1.5 days of water, all replaced; hunger 0.6 is 4.3 days of food, of which a
    // full bout replaces 2.5 (sim_0.36.0: no one-day cap).
    expect(s.child.nursingIntake!.foodDays).toBeCloseTo(2.5, 12);
    expect(s.child.nursingIntake!.waterDays).toBeCloseTo(1.5, 9);
    expect(s.child.drives.thirst).toBeCloseTo(0, 9);
    const final = structuredClone(s.child); s.finish(); expect(s.child).toEqual(final);
    expect(nursingEligible(s.child, s.cfg, 20 * hour, 21 * hour)).toBe(false);
    expect(nursingEligible(s.child, s.cfg, 43 * hour, 44 * hour)).toBe(true);
    expect(nursingBudget(s.child, 1)).toMatchObject({ cycle: 1, foodDays: 0, waterDays: 0, contactSeconds: 0 });
  });
  it('caps the bout at window closing and does not turn daytime contact into nursing', () => {
    const s = fixture();
    s.parentVisit.arrival = 23 * hour - 20; s.childVisit.arrival = 23 * hour - 10;
    finishCare(s.parentVisit, [s.child], s.starts, s.cfg, 22 * hour, 24 * hour, s.log, s.arrivals);
    expect(s.child.nursingIntake!.contactSeconds).toBe(10);
    const before = structuredClone(s.child);
    finishCare({ ...s.parentVisit, arrival: 24 * hour }, [s.child], s.starts, s.cfg, 24 * hour, 25 * hour, s.log, s.arrivals);
    expect(s.child).toEqual(before);
  });
  it.each(['parent_dead', 'young_dead', 'interrupted', 'moved_after_arrival', 'unreachable'])
    ('does not fabricate a feed when %s', reason => {
      const s = fixture();
      if (reason === 'parent_dead') s.parent.alive = false;
      if (reason === 'young_dead') s.child.alive = false;
      if (reason === 'interrupted') s.child.lastEncounterAt = start;
      if (reason === 'moved_after_arrival') s.child.position!.x += 0.01;
      if (reason === 'unreachable') s.childVisit.arrival = Infinity;
      const before = structuredClone(s.child.drives); s.finish();
      expect(s.child.drives).toEqual(before); expect(s.child.nursingIntake).toBeUndefined();
    });
  it('requires available parent reserves and schedules care only in the opportunity', () => {
    const s = fixture();
    expect(chooseCareTarget(s.parent, [s.child], s.cfg, 12 * hour)).toBeUndefined();
    expect(chooseCareTarget(s.parent, [s.child], s.cfg, start)).toBe(s.child);
    s.parent.drives.hunger = 0.8; s.parent.drives.thirst = 0.8;
    s.finish(); expect(s.child.nursingIntake).toBeUndefined();
    expect(chooseCareTarget(s.parent, [s.child], s.cfg, start)).toBeUndefined();
  });
  it('establishes a stable shared rendezvous without relocating young or inventing a birth site', () => {
    const s = fixture(); delete s.child.nursingSite;
    const sibling = structuredClone(s.child); sibling.id = 'a'; sibling.position!.x = 20;
    const positions = [structuredClone(s.child.position), structuredClone(sibling.position)];
    establishNursingSites(s.parent, [s.child, sibling], s.cfg, start, s.log);
    expect(s.child.nursingSite).toEqual({ patchId: 0, position: positions[1], establishedAt: start, origin: 'established' });
    expect(sibling.nursingSite).toEqual(s.child.nursingSite);
    expect(sibling.nursingSite).not.toBe(s.child.nursingSite);
    expect([s.child.position, sibling.position]).toEqual(positions);
    establishNursingSites(s.parent, [sibling, s.child], s.cfg, start + hour, s.log);
    expect(s.log.all().filter(e => e.type === 'nursing_site_established')).toHaveLength(1);
    expect(s.child.nursingSite!.establishedAt).toBe(start);
  });
  it('preserves a known birth site when another child lacks one', () => {
    const s = fixture(), sibling = structuredClone(s.child); sibling.id = 'a'; delete sibling.nursingSite;
    establishNursingSites(s.parent, [sibling, s.child], s.cfg, start, s.log);
    expect(sibling.nursingSite).toEqual(s.child.nursingSite);
    expect(sibling.nursingSite!.origin).toBe('birth');
  });
});

describe('world nursing rendezvous', () => {
  const options = { seed: 5, speciesDir: SPECIES_DIR, initialAgents: { hare: 6 }, minPopulation: {} };
  function family() {
    const initial = createWorld(options), snapshot = takeSnapshot(initial);
    snapshot.worldTime = start;
    const world = restoreSnapshot(snapshot, options), [parent, ...children] = world.agents;
    for (const p of world.patches) p.habitat = 'grassland';
    Object.assign(parent!, { patchId: 0, sex: 'female', pregnantSince: null, position: { x: -100, z: 0, heading: 0 },
      drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 }, offspringIds: children.map(c => c.id) });
    children.forEach((child, i) => Object.assign(child, { patchId: 0, ageDays: 5, lifeStage: 'newborn', massKg: 0.3,
      dependentOn: parent!.id, motherId: parent!.id, pregnantSince: null,
      position: { x: 20 + i * 20, z: 0, heading: 0 }, drives: { hunger: 0.1, thirst: 0.2, fatigue: 0, fear: 0 },
      nursingSite: { patchId: 0, position: { x: 0, z: 0, heading: 0 }, establishedAt: 0, origin: 'birth' } }));
    return { world, parent: parent!, children };
  }
  it('reunites a scattered litter by real individual routes, with one independently timed feed per child', () => {
    const s = family(), before = new Map(s.world.agents.map(a => [a.id, { ...a.position! }]));
    s.world.step(1);
    const feeds = s.world.log.all().filter(e => e.type === 'provisioned');
    expect(new Set(feeds.map(e => e.actors[0]))).toEqual(new Set(s.children.map(c => c.id)));
    for (const feed of feeds) {
      expect(feed.causalParents).toHaveLength(2);
      const routes = feed.causalParents.map(id => s.world.log.all().find(e => e.id === id)!);
      expect(routes.every(e => isMovementTrace(e.movement))).toBe(true);
      expect(Number(feed.conditions.arrivalWorldTime)).toBeGreaterThan(start);
      expect(Number(feed.conditions.provisioningSeconds)).toBeLessThanOrEqual(300);
      expect(feed.worldTime).toBeLessThan(start + hour);
    }
    for (const child of s.children) {
      expect(child.position).not.toEqual(before.get(child.id));
      expect(Math.hypot(child.position!.x - s.parent.position!.x, child.position!.z - s.parent.position!.z)).toBeLessThanOrEqual(careRadius(s.world.species.get('hare')!) + 1e-8);
      expect(child.nursingIntake!.completed).toBe(true);
    }
  });
  it('persists rendezvous and daily budget across snapshot restart, without repeating same-day feeding', () => {
    const s = family(); s.world.step(1);
    const restored = restoreSnapshot(takeSnapshot(s.world), options);
    expect(restored.agents).toEqual(s.world.agents);
    s.world.log.take();
    for (let i = 0; i < 3; i++) { s.world.step(1); restored.step(1); }
    expect(restored.agents).toEqual(s.world.agents); expect(restored.log.all()).toEqual(s.world.log.all());
    expect(restored.log.all().filter(e => e.type === 'provisioned')).toHaveLength(0);
    for (let i = 0; i < 24; i++) { s.world.step(1); restored.step(1); }
    expect(restored.agents).toEqual(s.world.agents); expect(restored.log.all()).toEqual(s.world.log.all());
    expect(restored.log.all().some(e => e.type === 'provisioned' && e.conditions.nursingCycle === 1)).toBe(true);
  });
  it('records birth-site provenance with detached coordinates but no same-tick fictional feeding', () => {
    const world = createWorld({ ...options, initialAgents: { hare: 1 } }), parent = world.agents[0]!;
    parent.sex = 'female'; parent.pregnantSince = -42 * 86400;
    const birthPoint = { ...parent.position! };
    world.step(1);
    const young = world.agents.filter(c => c.dependentOn === parent.id);
    expect(young.length).toBeGreaterThanOrEqual(2);
    for (const child of young) {
      expect(child.nursingSite).toEqual({ patchId: parent.patchId, position: birthPoint, establishedAt: 0, origin: 'birth' });
      expect(child.nursingSite!.position).not.toBe(parent.position);
    }
    expect(world.log.all().some(e => e.type === 'provisioned')).toBe(false);
  });
  it('requires a v0.11-specific upgrade, preserving old positions without fabricating birth sites', () => {
    const s = family(), old = asLegacySnapshot(takeSnapshot(s.world), 'sim_0.11.0');
    for (const a of old.agents) delete a.nursingSite;
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV11Snapshot(old);
    expect(upgraded.simVersion).toBe(SIM_VERSION); expect(upgraded.agents).toEqual(old.agents);
    expect(old).toEqual(before); expect(upgraded.agents).not.toBe(old.agents);
    expect(() => upgradeV11Snapshot({ ...old, simVersion: 'sim_0.10.0' })).toThrow();
    const world = restoreSnapshot(upgraded, options); world.step(1);
    expect(world.log.all().filter(e => e.type === 'nursing_site_established')).toHaveLength(1);
    expect(world.agents.filter(a => a.dependentOn).every(a => a.nursingSite?.origin === 'established')).toBe(true);
  });
});
