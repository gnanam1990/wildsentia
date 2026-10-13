import { describe, expect, it } from 'vitest';
import { createRng, initialPosition, isMovementTrace, movementAt, treeAnchorForPatch,
  treeAnchorGeometry, type Agent } from '@vana/shared';
import { executeGoal } from '../src/agents/behaviours.js';
import { navigate } from '../src/agents/navigation.js';
import { perceive } from '../src/agents/perception.js';
import { EventLog } from '../src/events/log.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { createWorld, SIM_VERSION } from '../src/world.js';
import { makeAgent, makeServices, makeView, SPECIES_DIR, speciesOf } from './helpers.js';
import { ISLAND_GRID } from '@vana/shared';

const options = { seed: 17, speciesDir: SPECIES_DIR, initialAgents: { langur: 1, tiger: 1 }, minPopulation: {},
  retainEvents: 'all' as const };

function threatenedWorld() {
  const world = createWorld(options), patch = world.patches.find(p => treeAnchorForPatch(ISLAND_GRID, p))!;
  const anchor = treeAnchorForPatch(ISLAND_GRID, patch)!;
  const langur = world.agents.find(a => a.speciesId === 'langur')!;
  const tiger = world.agents.find(a => a.speciesId === 'tiger')!;
  Object.assign(langur, { patchId: patch.id, position: { x: anchor.x + 12, z: anchor.z + 5, heading: 0 },
    sex: 'male', dependentOn: null, pregnantSince: null, offspringIds: [],
    drives: { hunger: .05, thirst: .05, fatigue: 0, fear: 1 } });
  Object.assign(tiger, { patchId: patch.id, position: { x: anchor.x + 25, z: anchor.z + 15, heading: 0 },
    drives: { hunger: .2, thirst: .2, fatigue: 0, fear: 0 } });
  return { world, patch, anchor, langur, tiger };
}

describe('v0.25 authoritative tree ascent and descent', () => {
  it('routes to one exact trunk, spends remaining seconds vertically, and emits one truthful composite trace', () => {
    const { world, patch, anchor, langur } = threatenedWorld();
    const from = { ...langur.position! };
    world.log.take(); world.step(1);
    const climbs = world.log.byActor(langur.id).filter(e => e.type === 'tree_climbed');
    expect(climbs).toHaveLength(1);
    expect(world.log.byActor(langur.id).filter(e => e.type === 'moved' || e.type === 'fled')).toHaveLength(0);
    const event = climbs[0]!, trace = event.movement!;
    expect(event.simVersion).toBe(SIM_VERSION);
    expect(event.conditions).toMatchObject({ direction: 'ascend', reason: 'local_threat', treeAnchorId: anchor.id });
    expect(event.outcome).toBe('success');
    expect(event.effects.horizontalDistanceM).toBeGreaterThan(0);
    expect(event.effects.verticalDistanceM).toBe(6);
    expect(isMovementTrace(ISLAND_GRID, trace)).toBe(true);
    expect(trace.samples[0]!.position).toEqual(from);
    expect(trace.samples[0]!.altitudeM).toBeUndefined();
    for (let i = 1; i < trace.samples.length; i++)
      expect(trace.samples[i]!.seconds).toBeGreaterThan(trace.samples[i - 1]!.seconds);
    const last = trace.samples.at(-1)!;
    expect(last.seconds).toBeLessThan(3600);
    expect(last.position.x).toBe(anchor.x); expect(last.position.z).toBe(anchor.z);
    expect(last.altitudeM).toBe(6);
    const firstElevated = trace.samples.findIndex(sample => (sample.altitudeM ?? 0) > 0);
    expect(firstElevated).toBeGreaterThan(0);
    expect(trace.samples[firstElevated - 1]!.altitudeM).toBe(0);
    expect(trace.samples[firstElevated - 1]!.position.x).toBe(anchor.x);
    expect(trace.samples[firstElevated - 1]!.position.z).toBe(anchor.z);
    expect(langur.position).toEqual(last.position);
    expect(langur.altitudeM).toBe(6);
    expect(langur.treeAnchorId).toBe(anchor.id);
    expect(movementAt(trace, last.seconds - 12).altitudeM).toBeGreaterThan(0);
    expect(world.log.all().some(e => e.type === 'hunt' && e.actors[1] === langur.id)).toBe(false);
    expect(patch.id).toBe(langur.patchId);
  });

  it('keeps the clock on whole seconds, so a part-hour step cannot stop a later descent', () => {
    // 0.1 + 0.2 h is 1080.0000000000002 s: the clock left whole seconds, and the next descent's
    // trace (which must start on a whole second) threw and stopped the world mid-step.
    const { world, patch, langur } = threatenedWorld();
    world.step(0.1 + 0.2);
    expect(langur.altitudeM).toBeGreaterThan(0);
    expect(world.now()).toBe(1080);
    patch.canopyCover = 0;
    expect(() => world.step(1)).not.toThrow();
    expect(world.now()).toBe(4680);
    expect(langur.altitudeM).toBeUndefined();
    // A step that is not a whole number of seconds is refused before anything changes.
    expect(() => world.step(1 / 7)).toThrow(/whole seconds/);
    expect(world.now()).toBe(4680);
  });

  it('descends a depleted-canopy remnant with real time and never takes a ground action in that decision', () => {
    const { world, patch, anchor, langur } = threatenedWorld();
    world.step(1);
    expect(langur.altitudeM).toBe(6);
    patch.canopyCover = 0;
    const before = world.now(); world.log.take(); world.step(1);
    const events = world.log.byActor(langur.id), descent = events.find(e => e.type === 'tree_climbed')!;
    expect(descent).toBeDefined();
    expect(descent.conditions).toMatchObject({ direction: 'descend', reason: 'canopy_lost', treeAnchorId: anchor.id });
    expect(descent.effects).toMatchObject({ horizontalDistanceM: 0, verticalDistanceM: 6, durationSeconds: 24 });
    expect(descent.movement?.startWorldTime).toBe(before);
    expect(descent.movement?.samples.map(s => s.altitudeM)).toEqual([6, 0]);
    expect(isMovementTrace(ISLAND_GRID, descent.movement)).toBe(true);
    expect(langur.position?.x).toBe(anchor.x); expect(langur.position?.z).toBe(anchor.z);
    expect(langur.altitudeM).toBeUndefined(); expect(langur.treeAnchorId).toBeUndefined();
    expect(events.some(e => ['moved', 'fled', 'fed', 'drank', 'courtship'].includes(e.type))).toBe(false);
  });

  it('resumes a saved partial perch and descends after canopy loss without a second ground action', () => {
    const { world, patch, anchor, langur } = threatenedWorld();
    world.step(1);
    const saved = takeSnapshot(world);
    const perched = saved.agents.find(a => a.id === langur.id)!;
    perched.altitudeM = 2;
    saved.patches[patch.id]!.canopyCover = 0;
    const restored = restoreSnapshot(saved, options);
    const animal = restored.agents.find(a => a.id === langur.id)!;
    const before = restored.now();
    restored.log.take(); restored.step(1);
    const events = restored.log.byActor(animal.id);
    const descent = events.find(e => e.type === 'tree_climbed')!;
    expect(descent.conditions).toMatchObject({ direction: 'descend', reason: 'canopy_lost', treeAnchorId: anchor.id });
    expect(descent.effects).toMatchObject({ verticalDistanceM: 2, durationSeconds: 8 });
    expect(descent.movement?.startWorldTime).toBe(before);
    expect(descent.movement?.samples.map(s => s.altitudeM)).toEqual([2, 0]);
    expect(animal.altitudeM).toBeUndefined(); expect(animal.treeAnchorId).toBeUndefined();
    expect(events.filter(e => e.movement)).toHaveLength(1);
    expect(events.some(e => ['fed', 'drank', 'courtship'].includes(e.type))).toBe(false);
  });

  it('descends when threat has gone, without inventing food, water or a second route', () => {
    const { world, langur, tiger } = threatenedWorld();
    world.step(1);
    tiger.patchId = (langur.patchId + 20) % world.patches.length;
    tiger.position = initialPosition(ISLAND_GRID, tiger.id, tiger.patchId);
    const prior = { hunger: langur.drives.hunger, thirst: langur.drives.thirst };
    world.log.take(); world.step(1);
    const event = world.log.byActor(langur.id).find(e => e.type === 'tree_climbed')!;
    expect(event.conditions.reason).toBe('threat_gone');
    expect(langur.altitudeM).toBeUndefined();
    expect(langur.drives.hunger).toBeGreaterThanOrEqual(prior.hunger);
    expect(langur.drives.thirst).toBeGreaterThanOrEqual(prior.thirst);
    expect(world.log.byActor(langur.id).filter(e => e.movement)).toHaveLength(1);
  });

  it('records a death-time gravity collapse and grounds the carcass without a dead hovering agent', () => {
    const { world, anchor, langur } = threatenedWorld();
    world.step(1);
    expect(langur.altitudeM).toBe(6);
    langur.ageDays = world.species.get('langur')!.lifecycle.maxAgeDays - .01;
    world.log.take(); world.step(1);
    const death = world.log.byActor(langur.id).find(e => e.type === 'died')!;
    expect(death.conditions).toMatchObject({ deathAltitudeM: 6, fallPolicy: 'death_time_gravity_collapse' });
    expect(death.effects.fallDistanceM).toBe(6);
    expect(langur.alive).toBe(false);
    expect(langur.altitudeM).toBeUndefined(); expect(langur.locomotionMode).toBeUndefined();
    expect(langur.treeAnchorId).toBeUndefined();
    const carcass = world.carcasses.find(c => c.originId === langur.id)!;
    expect(carcass.position?.x).toBe(anchor.x); expect(carcass.position?.z).toBe(anchor.z);
    expect(carcass.position).toEqual(death.position);
    expect(takeSnapshot(world).agents.find(a => a.id === langur.id)?.altitudeM).toBeUndefined();
  });

  it('does not report successful ascent when reaching the trunk consumes all available time', () => {
    const patches = threatenedWorld().world.patches;
    const patch = patches.find(p => treeAnchorForPatch(ISLAND_GRID, p))!, anchor = treeAnchorForPatch(ISLAND_GRID, patch)!;
    const animal = makeAgent('langur', { id: 'langur-zero-budget', patchId: patch.id,
      position: { x: anchor.x + 10, z: anchor.z, heading: 0 }, drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 1 } });
    const tiger = makeAgent('tiger', { id: 'tiger-threat', patchId: patch.id,
      position: { x: anchor.x + 20, z: anchor.z, heading: 0 } });
    const cfg = speciesOf('langur'), view = makeView(patches, [animal, tiger]);
    const probe = structuredClone(animal) as Agent;
    const duration = navigate(ISLAND_GRID, probe, cfg, patches, patch.id, 'flee', 0, 3600, true,
      { x: anchor.x, z: anchor.z, heading: 0 }).seconds;
    expect(duration).toBeGreaterThan(0);
    const log = new EventLog(17, SIM_VERSION);
    executeGoal({ agent: animal, species: cfg, patches, view, percept: perceive(animal, cfg, view),
      choice: { goal: 'flee', score: 1, alternative: 'rest' }, hours: duration / 3600, worldTime: 0,
      log, rng: createRng(17, 'zero-budget'), services: makeServices([]) });
    const event = log.all().find(e => e.type === 'tree_climbed')!;
    expect(event).toBeDefined();
    expect(event.effects.verticalDistanceM).toBe(0);
    expect(event.outcome).toBe('interrupted');
    expect(event.movement?.completed).toBe(false);
    expect(animal.altitudeM).toBeUndefined();
  });

  it('makes aggregated multi-hour steps equivalent to hourly decisions when arboreal agents exist', () => {
    const a = threatenedWorld(), b = threatenedWorld();
    a.world.step(24);
    for (let hour = 0; hour < 24; hour++) b.world.step(1);
    expect(takeSnapshot(a.world)).toEqual(takeSnapshot(b.world));
    expect(a.world.log.all()).toEqual(b.world.log.all());
  });

  it('excludes a saved elevated animal from planar prey detection', () => {
    const { world, patch, anchor, langur, tiger } = threatenedWorld();
    langur.position = { x: anchor.x, z: anchor.z, heading: 0 };
    langur.altitudeM = 3; langur.locomotionMode = 'climb'; langur.treeAnchorId = treeAnchorGeometry(ISLAND_GRID, patch.id)!.id;
    const view = makeView(world.patches, [langur, tiger]);
    expect(perceive(tiger, speciesOf('tiger'), view).prey.some(p => p.agent.id === langur.id)).toBe(false);
    delete langur.altitudeM; delete langur.locomotionMode; delete langur.treeAnchorId;
    expect(perceive(tiger, speciesOf('tiger'), view).prey.some(p => p.agent.id === langur.id)).toBe(true);
  });
});
