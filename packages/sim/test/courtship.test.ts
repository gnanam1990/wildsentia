import { describe, expect, it, vi } from 'vitest';
import { createRng, isMovementTrace, positionInPatch, patchCentre } from '@vana/shared';
import { approachMate, finishCourtship } from '../src/agents/courtship.js';
import { EventLog } from '../src/events/log.js';
import { buildGrid } from '../src/grid.js';
import { createWorld, SIM_VERSION } from '../src/world.js';
import { ISLAND_POPULATION } from '../src/forest.js';
import { restoreSnapshot, takeSnapshot, upgradeV15Snapshot } from '../src/snapshot.js';
import { makeAgent, speciesOf, SPECIES_DIR } from './helpers.js';
import { asLegacySnapshot } from './legacySnapshot.js';

function fixture() {
  const patches = buildGrid(1); for (const patch of patches) patch.habitat = 'grassland';
  const female = makeAgent('chital', { id: 'female', position: { x: 140, z: 0, heading: 0 } });
  const male = makeAgent('chital', { id: 'male', sex: 'male', patchId: 1, position: { x: 180, z: 0, heading: 0 } });
  const cfg = speciesOf('chital'), log = new EventLog(1, SIM_VERSION), rng = createRng(1, 'courtship');
  const target = { patchId: male.patchId, position: { ...male.position! } };
  return { patches, female, male, cfg, log, rng, target };
}

describe('physical mate approach and end-of-tick contact', () => {
  it('lets a receptive later-acting pack mate wait at the real contact anchor', () => {
    const world = createWorld({ seed: 1, speciesDir: SPECIES_DIR,
      initialAgents: { dhole: 3 }, minPopulation: {} });
    world.agents.forEach((agent, i) => Object.assign(agent, { sex: i === 0 ? 'female' : 'male',
      patchId: 0, position: { x: i * .1, z: 0, heading: 0 }, ageDays: 1000,
      drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 1 } }));
    world.step(1);
    const response = world.log.all().find(event => event.type === 'rested'
      && event.conditions.reason === 'await_mate' && event.actors[0]?.startsWith('dhole_'));
    expect(response).toBeDefined();
    const trial = world.log.all().find(event => event.type === 'courtship'
      && event.conditions.species === 'dhole' && event.actors[1] === response!.actors[0]);
    expect(trial?.conditions.reason).toBe('contact_trial');
    expect(trial?.outcome).not.toBe('interrupted');
    expect(response?.position).toEqual(world.agents.find(agent => agent.id === response?.actors[0])?.position);
  });
  it('does not make a thirsty partner wait for mating instead of attending to its need', () => {
    const world = createWorld({ seed: 1, speciesDir: SPECIES_DIR,
      initialAgents: { dhole: 2 }, minPopulation: {} });
    world.agents.forEach((agent, i) => Object.assign(agent, { sex: i === 0 ? 'female' : 'male',
      patchId: 0, position: { x: i * .1, z: 0, heading: 0 }, ageDays: 1000,
      drives: { hunger: 0, thirst: i === 0 ? 0 : .6, fear: 0, fatigue: 1 } }));
    world.step(1);
    expect(world.log.all().some(event => event.type === 'rested'
      && event.conditions.reason === 'await_mate')).toBe(false);
  });
  it('rechecks the one-pregnancy pack limit when simultaneous visits finish', () => {
    let conceptions = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: { dhole: 3 }, minPopulation: {} });
      world.agents.forEach((a, i) => Object.assign(a, { sex: i < 2 ? 'female' : 'male', patchId: 0,
        position: { x: i * .1, z: 0, heading: 0 }, ageDays: 1000,
        drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 1 } }));
      world.step(1);
      const count = world.agents.filter(a => a.pregnantSince !== null).length;
      expect(count).toBeLessThanOrEqual(1); conceptions += count;
    }
    expect(conceptions).toBeGreaterThan(0);
  });
  it('crosses a patch boundary through a recorded route before any conception trial', () => {
    const f = fixture(), bool = vi.spyOn(f.rng, 'bool').mockReturnValue(true);
    const visit = approachMate(f.female, f.male, f.target, f.cfg, f.patches, 0, 1, 0, f.log);
    expect(visit.arrival).toBeGreaterThan(0); expect(visit.arrival).toBeLessThan(3600);
    expect(f.female.patchId).toBe(1); expect(positionInPatch(f.female.position, 1)).toBe(true);
    expect(f.female.pregnantSince).toBeNull(); expect(bool).not.toHaveBeenCalled();
    const route = f.log.all()[0]!; expect(isMovementTrace(route.movement)).toBe(true);
    expect(route.movement!.samples[0]!.position.x).toBe(140);
    finishCourtship(visit, f.cfg, 0, 3600, 2, f.rng, f.log);
    expect(f.female.pregnantSince).toBe(3600); expect(f.female.pregnancyFatherId).toBe('male');
    const event = f.log.all().at(-1)!;
    expect(event.outcome).toBe('success'); expect(event.worldTime).toBe(3600);
    expect(event.causalParents).toEqual([route.id]); expect(event.position).toEqual(f.female.position);
  });
  it.each(['moved', 'died', 'unreceptive', 'encounter'] as const)('does not conceive when the mate %s after the approach began', cause => {
    const f = fixture(), bool = vi.spyOn(f.rng, 'bool');
    const visit = approachMate(f.female, f.male, f.target, f.cfg, f.patches, 0, 1, 0, f.log);
    if (cause === 'moved') f.male.position!.x += 20;
    if (cause === 'died') f.male.alive = false;
    if (cause === 'unreceptive') f.male.drives.thirst = .99;
    if (cause === 'encounter') f.male.lastEncounterAt = 0;
    finishCourtship(visit, f.cfg, 0, 3600, 2, f.rng, f.log);
    expect(f.female.pregnantSince).toBeNull(); expect(f.female.nextOestrusAt).toBeUndefined();
    expect(bool).not.toHaveBeenCalled(); expect(f.log.all().at(-1)!.outcome).toBe('interrupted');
  });
  it('does not infer end-of-hour mating from equal planar coordinates when a partner climbed', () => {
    const f = fixture(), bool = vi.spyOn(f.rng, 'bool');
    const visit = approachMate(f.female, f.male, f.target, f.cfg, f.patches, 0, 1, 0, f.log);
    expect(visit.arrival).toBeLessThan(3600);
    f.male.altitudeM = 2;
    finishCourtship(visit, f.cfg, 0, 3600, 2, f.rng, f.log);
    expect(f.female.pregnantSince).toBeNull();
    expect(f.log.all().at(-1)?.outcome).toBe('interrupted');
    expect(bool).not.toHaveBeenCalled();
  });
  it('spends travel time and cannot turn a partial or blocked route into mating', () => {
    const f = fixture(), bool = vi.spyOn(f.rng, 'bool');
    const partial = approachMate(f.female, f.male, f.target, f.cfg, f.patches, 0, 1 / 3600, 0, f.log);
    expect(partial.arrival).toBe(Infinity); expect(f.female.position!.x).toBeLessThan(145);
    expect(positionInPatch(f.female.position, f.female.patchId)).toBe(true);
    finishCourtship(partial, f.cfg, 0, 1, 2, f.rng, f.log); expect(bool).not.toHaveBeenCalled();
    f.patches[1]!.surface = 'ocean';
    const blocked = approachMate(f.female, f.male, f.target, f.cfg, f.patches, 1, 1, 0, f.log);
    finishCourtship(blocked, f.cfg, 1, 3601, 2, f.rng, f.log);
    expect(f.female.pregnantSince).toBeNull(); expect(f.log.all().at(-1)!.outcome).toBe('abandoned');
  });
  it('does not claim same-patch contact across hundreds of metres; real rejection ends the cycle', () => {
    const f = fixture(); f.male.patchId = 0; f.male.position!.x = -100;
    const target = { patchId: 0, position: { ...f.male.position! } };
    const visit = approachMate(f.female, f.male, target, f.cfg, f.patches, 0, 1, 0, f.log);
    expect(f.log.all()[0]!.effects.distanceM).toBeGreaterThan(230);
    vi.spyOn(f.rng, 'bool').mockReturnValue(false); finishCourtship(visit, f.cfg, 0, 3600, 2, f.rng, f.log);
    expect(f.female.pregnantSince).toBeNull(); expect(f.female.nextOestrusAt).toBeGreaterThan(3600);
  });
  it('keeps every agent position/patch consistent across the full island founding cohort and replay', () => {
    const config = { seed: 1, speciesDir: SPECIES_DIR, terrainProfile: 'island_v1' as const,
      initialAgents: ISLAND_POPULATION, minPopulation: {} };
    const world = createWorld(config);
    for (let hour = 0; hour < 12; hour++) {
      world.step(1);
      expect(world.agents.filter(a => a.alive && !positionInPatch(a.position, a.patchId)).map(a => a.id)).toEqual([]);
    }
    const restored = restoreSnapshot(takeSnapshot(world), config);
    world.step(12); restored.step(12); expect(takeSnapshot(restored)).toEqual(takeSnapshot(world));
    expect(world.log.all().some(e => e.type === 'moved' && e.goal === 'breed')).toBe(true);
  });
  it('requires exact-source opt-in and refuses to invent a repair for contradictory old spatial state', () => {
    const world = createWorld({ seed: 1, speciesDir: SPECIES_DIR, initialAgents: { chital: 2 } });
    const old = asLegacySnapshot(takeSnapshot(world), 'sim_0.15.0');
    const next = upgradeV15Snapshot(old); expect(next.simVersion).toBe(SIM_VERSION); expect(old.simVersion).toBe('sim_0.15.0');
    expect(next.agents).toEqual(old.agents);
    old.agents[0]!.position = { ...patchCentre((old.agents[0]!.patchId + 1) % 400), heading: 0 };
    expect(() => upgradeV15Snapshot(old)).toThrow('recovery review');
    expect(() => upgradeV15Snapshot(next)).toThrow('only sim_0.15.0');
  });
});
