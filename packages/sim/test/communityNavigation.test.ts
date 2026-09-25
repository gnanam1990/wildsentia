import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { islandHeightAt, isCommunityState, patchAtPosition, patchCentre, positionInPatch } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { stepCommunity } from '../src/community.js';
import { explorationSite, humanRoute, humanWalkable, nearbyResource, travelHuman } from '../src/communityNavigation.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const options = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialCommunityRulesVersion: 5 as const, initialAgents: {}, minPopulation: {} };

// Explicit finite-resource fixture, not claimed to be a naturally grown cohort.
function fixture() {
  const w = createWorld(options), c = w.community!, person = c.people[0]!, home = w.patches[c.patchId]!;
  const source = w.patches[home.neighbours.filter(id => humanWalkable(w.patches[id])).sort((a, b) => a - b)[0]!]!;
  for (const patch of w.patches) patch.plant.browse = 0;
  source.plant.browse = 20; c.stores.waterL = 20;
  person.needs = { hunger: .1, thirst: .1, fatigue: .1 };
  for (const other of c.people.slice(1)) { other.alive = false; other.diedAt = 0; }
  const step = (seconds: number) => stepCommunity(c, w.patches, w.waterBudget, c.updatedAt, seconds, w.log, w.microEcology);
  return { w, c, person, home, source, step };
}

describe('household v5 cross-patch resource journeys', () => {
  it('walks to finite neighbouring food, works at contact, carries it home and conserves every material transfer', () => {
    const { w, c, person, home, source, step } = fixture(), baseline = w.totalNutrients(), origin = { ...person.position };
    step(1);
    expect(person.task).toMatchObject({ kind: 'gather_food', phase: 'travel', journey: { destinationPatchId: source.id } });
    expect(Math.hypot(person.position.x - origin.x, person.position.z - origin.z)).toBeCloseTo(1.1, 8);
    expect(person.inventory.foodKg).toBe(0); expect(source.plant.browse).toBe(20);
    for (let minute = 0; minute < 60 && person.inventory.foodKg === 0; minute++) {
      step(60); expect(positionInPatch(person.position, person.patchId)).toBe(true); expect(isCommunityState(c)).toBe(true);
    }
    const gathering = w.log.all().find(e => e.type === 'human_task_finished' && e.conditions.action === 'gather_food')!;
    expect(gathering).toMatchObject({ patchId: source.id, conditions: { sourcePatchId: source.id }, outcome: 'success' });
    expect(positionInPatch(gathering.position, source.id)).toBe(true);
    expect(source.plant.browse).toBeCloseTo(20 - gathering.effects.foodKg!, 9);
    expect(home.plant.browse).toBe(0); expect(c.stores.foodKg).toBe(0); expect(person.inventory.foodKg).toBeGreaterThan(0);
    expect(person.task).toMatchObject({ kind: 'deliver', journey: { destinationPatchId: home.id } });
    for (let minute = 0; minute < 30 && c.stores.foodKg === 0; minute++) step(60);
    const delivered = w.log.all().find(e => e.type === 'human_task_finished' && e.conditions.action === 'deliver')!;
    expect(delivered.patchId).toBe(home.id); expect(delivered.position).toMatchObject({ x: c.building.position.x, z: c.building.position.z });
    expect(c.stores.foodKg).toBeGreaterThan(0); expect(w.totalNutrients()).toBeCloseTo(baseline, 7);
    expect(isCommunityState(c)).toBe(true);
  });

  it('rechecks a depleted destination after arrival instead of paying out stock from the old plan or the home patch', () => {
    const { w, c, person, source, step } = fixture(); step(1); source.plant.browse = 0;
    step(1800);
    const attempts = w.log.all().filter(e => e.type === 'human_task_finished' && e.conditions.action === 'gather_food');
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ outcome: 'failure', patchId: source.id, effects: { foodKg: 0 } });
    expect(person.inventory.foodKg).toBe(0); expect(c.stores.foodKg).toBe(0); expect(isCommunityState(c)).toBe(true);
  });

  it.each(['gather_timber', 'gather_fibre'] as const)('carries remote %s material back through the same finite construction supply path', kind => {
    const { w, c, person, source, step } = fixture(); c.stores.foodKg = 20;
    if (kind === 'gather_fibre') {
      c.stores.timberKg = 48;
      for (const patch of w.patches) patch.plant.grass = 0;
      source.plant.grass = 20;
    }
    const key = kind === 'gather_timber' ? 'timberKg' : 'fibreKg', baseline = w.totalNutrients();
    step(1); expect(person.task).toMatchObject({ kind, journey: { destinationPatchId: source.id } });
    for (let minute = 0; minute < 80 && c.stores[key] === 0; minute++) step(60);
    expect(c.stores[key]).toBeGreaterThan(0);
    const event = w.log.all().find(e => e.type === 'human_resource_collected' && e.conditions.action === kind)!;
    expect(event).toMatchObject({ patchId: source.id, conditions: { sourcePatchId: source.id } });
    expect(event.effects[key]).toBeGreaterThan(0); expect(event.causalParents).toHaveLength(1);
    expect(w.totalNutrients()).toBeCloseTo(baseline, 7); expect(isCommunityState(c)).toBe(true);
  });

  it('fishes a neighbouring pool, records its true source, delivers raw catch and cooks it at home with finite fuel', () => {
    const { w, c, person, source, step } = fixture();
    for (const patch of w.patches) patch.plant.browse = 0;
    for (const pool of w.microEcology.patches) pool.fishBiomassKg = 0;
    const fish = w.microEcology.patches.find(p => p.patchId === source.id)!;
    fish.fishBiomassKg = 2; source.habitat = 'riparian'; source.waterVolume = 100;
    c.stores.timberKg = 3; person.skills.fishing = .99; person.skills.gathering = .1;
    const baseline = w.totalNutrients();
    step(1); expect(person.task).toMatchObject({ kind: 'fish', journey: { destinationPatchId: source.id } });
    expect(fish.fishBiomassKg).toBe(2); expect(person.inventory.rawFishKg).toBe(0);
    for (let minute = 0; minute < 12 * 60 && !w.log.all().some(e => e.type === 'human_task_finished' && e.conditions.action === 'cook' && e.outcome === 'success'); minute++) step(60);
    const remote = w.log.all().filter(e => e.type === 'human_resource_collected' && e.conditions.action === 'fish');
    expect(remote.length).toBeGreaterThan(0); expect(remote.every(e => e.patchId === source.id)).toBe(true);
    expect(fish.fishBiomassKg).toBeCloseTo(2 - remote.reduce((n, e) => n + e.effects.rawFishKg!, 0), 8);
    const cook = w.log.all().find(e => e.type === 'human_task_finished' && e.conditions.action === 'cook' && e.outcome === 'success')!;
    expect(cook).toBeDefined(); expect(cook.patchId).toBe(c.patchId);
    expect(cook.effects.fuelKg).toBeCloseTo(cook.effects.foodKg! * .1, 10);
    expect(w.totalNutrients()).toBeCloseTo(baseline, 7); expect(isCommunityState(c)).toBe(true);
  });

  it('withdraws remote freshwater only after travel and work, then drinks carried water with exact source accounting', () => {
    const { w, c, person, source, step } = fixture();
    for (const patch of w.patches) patch.waterVolume = 0;
    c.stores.waterL = 0; source.waterVolume = 5; person.needs.thirst = .6;
    step(1); expect(person.task).toMatchObject({ kind: 'collect_water', journey: { destinationPatchId: source.id } });
    expect(source.waterVolume).toBe(5); expect(w.waterBudget.communityWithdrawalL ?? 0).toBe(0);
    step(1000);
    const draws = w.log.all().filter(e => e.type === 'human_task_finished' && e.conditions.action === 'collect_water' && e.outcome === 'success');
    expect(draws.length).toBeGreaterThan(0); expect(draws.every(e => e.patchId === source.id)).toBe(true);
    const withdrawn = draws.reduce((n, e) => n + e.effects.waterL!, 0);
    expect(withdrawn).toBeLessThanOrEqual(5); expect(source.waterVolume).toBeCloseTo(5 - withdrawn, 9);
    expect(w.waterBudget.communityWithdrawalL).toBeCloseTo(withdrawn, 9);
    expect(person.needs.thirst).toBeLessThan(.3); expect(isCommunityState(c)).toBe(true);
  });

  it('routes around deep water, rejects coast/disconnected routes and charges travel without skipping waypoints', () => {
    const w = createWorld({ ...options, terrainProfile: 'mainland', communityProfile: 'none' });
    for (const p of w.patches) p.habitat = 'grassland';
    const from = { ...patchCentre(210), heading: 0 }, to = { ...patchCentre(212), heading: 0 };
    w.patches[211]!.habitat = 'water';
    const route = humanRoute(from, to, w.patches)!;
    expect(route.length).toBeGreaterThan(3); expect(route.every(point => patchAtPosition(point) !== 211)).toBe(true);
    const { person } = fixture(); person.position = from; person.patchId = 210;
    const task = { kind: 'gather_food' as const, phase: 'travel' as const, destination: to,
      remainingSeconds: 900, startedAt: 0, eventId: 'route-test', journey: { destinationPatchId: 212, waypoints: route } };
    expect(travelHuman(person, task, w.patches, 1)).toBeCloseTo(1);
    expect(Math.hypot(person.position.x - from.x, person.position.z - from.z)).toBeCloseTo(1.1);
    expect(task.remainingSeconds).toBe(900); expect(task.journey.waypoints.length).toBeGreaterThan(0);
    w.patches[212]!.surface = 'coast'; expect(humanRoute(from, to, w.patches)).toBeNull();
    delete w.patches[212]!.surface;
    for (const id of w.patches[210]!.neighbours) w.patches[id]!.habitat = 'water';
    expect(humanRoute(from, to, w.patches)).toBeNull();
  });

  it('keeps actual island paths above the shoreline and refuses stale dry labels over submerged mesh', () => {
    const w = createWorld({ ...options, communityProfile: 'none' });
    const from = { ...patchCentre(210), heading: 0 }, to = { ...patchCentre(212), heading: 0 };
    expect(w.patches[211]!.surface).toBe('land');
    w.patches[211]!.habitat = 'water';
    const route = humanRoute(from, to, w.patches)!;
    expect(route).not.toBeNull();
    expect(route.every(point => patchAtPosition(point) !== 211)).toBe(true);
    let previous = from;
    for (const point of route) {
      const metres = Math.hypot(point.x - previous.x, point.z - previous.z);
      for (let i = 0; i <= Math.ceil(metres / 25); i++) {
        const t = i / Math.max(1, Math.ceil(metres / 25));
        const x = previous.x + (point.x - previous.x) * t, z = previous.z + (point.z - previous.z) * t;
        expect(w.patches[patchAtPosition({ x, z, heading: 0 })]!.habitat).not.toBe('water');
        expect(islandHeightAt(1, x, z)).toBeGreaterThanOrEqual(2 - 1e-6);
      }
      previous = point;
    }
    // A wrongly marked coast cell is not safe merely because its patch label says land.
    const coast = w.patches[69]!;
    expect(coast.surface).toBe('coast');
    coast.surface = 'land'; coast.habitat = 'grassland';
    expect(humanRoute({ ...patchCentre(89), heading: 0 }, { ...patchCentre(69), heading: 0 }, w.patches)).toBeNull();
  });

  it('uses a reachable resource and exploration site when a nearer labelled-land coast cell is physically wet', () => {
    const { person } = fixture();
    const w = createWorld({ ...options, communityProfile: 'none' });
    person.position = { ...patchCentre(89), heading: 0 }; person.patchId = 89;
    person.visitedSites = [{ patchId: 89, at: 0 }];
    for (const patch of w.patches) patch.plant.browse = 0;
    w.patches[69]!.surface = 'land'; w.patches[69]!.habitat = 'grassland';
    w.patches[69]!.plant.browse = 20; w.patches[88]!.plant.browse = 10;
    expect(nearbyResource(person, 'gather_food', w.patches)).toBe(88);
    expect(explorationSite(person, w.patches)).toBe(88);
  });

  it('rejects a blocked later waypoint before moving, including incoherent diagonal trails', () => {
    const { person } = fixture();
    const w = createWorld({ ...options, terrainProfile: 'mainland', communityProfile: 'none' });
    for (const patch of w.patches) patch.habitat = 'grassland';
    const origin = { ...patchCentre(210), heading: 0 }, goal = { ...patchCentre(212), heading: 0 };
    person.position = { ...origin }; person.patchId = 210;
    const makeTask = (ids: number[]) => ({ kind: 'gather_food' as const, phase: 'travel' as const,
      destination: goal, remainingSeconds: 900, startedAt: 0, eventId: 'route-test',
      journey: { destinationPatchId: 212, waypoints: ids.map(id => ({ ...patchCentre(id), heading: 0 })) } });
    w.patches[211]!.habitat = 'water';
    const blocked = makeTask([210, 211, 212]);
    expect(() => travelHuman(person, blocked, w.patches, 300)).toThrow('invalid human land route');
    expect(person.position).toEqual(origin); expect(blocked.journey.waypoints).toHaveLength(3);
    w.patches[211]!.habitat = 'grassland';
    const diagonal = makeTask([210, 231, 212]);
    expect(() => travelHuman(person, diagonal, w.patches, 300)).toThrow('invalid human land route');
    expect(person.position).toEqual(origin); expect(diagonal.journey.waypoints).toHaveLength(3);
  });

  it('uses visited-site memory for exploration without seeing distant live resources', () => {
    const { w, person } = fixture();
    const far = w.patches.find(p => humanWalkable(p) && p.id !== person.patchId && !w.patches[person.patchId]!.neighbours.includes(p.id))!;
    for (const patch of w.patches) patch.plant.browse = 0;
    const target = explorationSite(person, w.patches)!;
    expect(nearbyResource(person, 'gather_food', w.patches, w.microEcology)).toBeNull();
    far.plant.browse = 10000;
    expect(nearbyResource(person, 'gather_food', w.patches, w.microEcology)).toBeNull();
    expect(explorationSite(person, w.patches)).toBe(target);
    person.visitedSites!.push({ patchId: target, at: 1 });
    expect(explorationSite(person, w.patches)).not.toBe(target);
  });

  it('restores in-flight routes and exploration exactly, rejects malformed routes, and does not upgrade saved v4 households', () => {
    const { w, c } = fixture(); w.step(.01);
    const saved = takeSnapshot(w); expect(c.people[0]!.task?.phase).toBe('travel');
    const b = restoreSnapshot(JSON.parse(JSON.stringify(saved)), options);
    w.log.take(); b.log.take();
    for (let i = 0; i < 20; i++) { w.step(.1); b.step(.1); }
    expect(takeSnapshot(b)).toEqual(takeSnapshot(w)); expect(b.log.all()).toEqual(w.log.all());
    expect(isCommunityState(w.community)).toBe(true);
    const bad = structuredClone(saved);
    bad.community!.people[0]!.task!.journey!.waypoints[0] = { ...patchCentre(399), heading: 0 };
    expect(isCommunityState(bad.community)).toBe(false); expect(() => restoreSnapshot(bad, options)).toThrow();
    const duplicate = structuredClone(saved.community!);
    duplicate.people[0]!.visitedSites!.push({ ...duplicate.people[0]!.visitedSites![0]! });
    expect(isCommunityState(duplicate)).toBe(false);
    const old = createWorld({ ...options, initialCommunityRulesVersion: 4 }); old.step(.01);
    const restored = restoreSnapshot(takeSnapshot(old), options);
    expect(restored.community!.version).toBe(4); expect(restored.community!.people[0]!.visitedSites).toBeUndefined();
    old.log.take(); restored.log.take(); old.step(2); restored.step(2);
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(old)); expect(restored.log.all()).toEqual(old.log.all());
  });

  it('returns carried spoilage and a remote body to its actual soil, not to the household patch', () => {
    const { w, c, person, home, source, step } = fixture();
    person.position = { ...patchCentre(source.id), heading: 0 }; person.patchId = source.id;
    person.alive = false; person.diedAt = 0; person.inventory.foodKg = 2;
    for (const p of c.people.slice(1)) { p.massKg = 0; }
    const homeSoil = home.soilNutrients, sourceSoil = source.soilNutrients, baseline = w.totalNutrients();
    step(60);
    expect(home.soilNutrients).toBe(homeSoil); expect(source.soilNutrients).toBeGreaterThan(sourceSoil);
    expect(w.totalNutrients()).toBeCloseTo(baseline, 8); expect(isCommunityState(c)).toBe(true);
  });
});
