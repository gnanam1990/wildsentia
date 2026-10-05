import { describe, expect, it } from 'vitest';
import { islandHeightAt, islandVertexHeight, islandPatchSurface, ISLAND_SEGMENTS, landWalkable, landRayDistance,
  patchCentre, patchAtPosition, createRng } from '@vana/shared';
import { buildGrid, islandFreshwaterBasinIds, ISLAND_BASIN_SEPARATION_PATCHES,
  ISLAND_INITIAL_LAKE_WATER_L } from '../src/grid.js';
import { createWorld } from '../src/world.js';
import { FOREST_POPULATION, ISLAND_POPULATION } from '../src/forest.js';
import { takeSnapshot, restoreSnapshot, upgradeV14Snapshot } from '../src/snapshot.js';
import { newWaterBudget, updateDrainage, waterBudgetResidual } from '../src/fields/drainage.js';
import { navigate, planRoute } from '../src/agents/navigation.js';
import { resolveSpatialHunt } from '../src/agents/encounters.js';
import { SPECIES_DIR, makeAgent, speciesOf } from './helpers.js';
import { asLegacySnapshot } from './legacySnapshot.js';

const options = { seed: 1, speciesDir: SPECIES_DIR, initialAgents: { chital: 30, tiger: 2, dhole: 6 },
  minPopulation: {}, terrainProfile: 'island_v1' as const };
describe('authoritative island geography', () => {
  it('starts the closed two-tiger island cohort with both sexes without adding agents or random draws', () => {
    for (const seed of [1, 2, 3, 4, 5, 17]) {
      const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: ISLAND_POPULATION,
        minPopulation: {}, terrainProfile: 'island_v1' });
      const founders = world.agents.filter(agent => agent.speciesId === 'tiger');
      expect(founders).toHaveLength(2);
      expect(founders.map(agent => agent.sex).sort()).toEqual(['female', 'male']);
      expect(founders.every(agent => agent.motherId === null && agent.fatherId === null && agent.generation === 0)).toBe(true);
      if (seed === 3) {
        // The v0.21 baseline had two males. The correction changes only the second sex;
        // both original IDs, placement and the first founder are preserved. Pinned to the
        // pre-v0.33 founding cohort (0.45 of the forest), whose draws those IDs come from.
        const legacy = createWorld({ seed, speciesDir: SPECIES_DIR, minPopulation: {}, terrainProfile: 'island_v1',
          initialAgents: Object.fromEntries(Object.entries(FOREST_POPULATION).map(([id, n]) => [id, Math.max(2, Math.round(n * 0.45))])) });
        const founders = legacy.agents.filter(agent => agent.speciesId === 'tiger');
        expect(founders.map(agent => agent.id)).toEqual(['tiger_06ff', 'tiger_0700']);
        expect(founders.map(agent => agent.patchId)).toEqual([267, 151]);
        expect(founders.map(agent => agent.sex)).toEqual(['male', 'female']);
        expect(founders[0]!.position).toMatchObject({ x: 2169.758754863813, z: 3858.674296177615 });
        expect(founders[1]!.position).toMatchObject({ x: 3218.6358434424355, z: 2074.3300526436255 });
      }
    }
    const one = createWorld({ seed: 3, speciesDir: SPECIES_DIR, initialAgents: { tiger: 1 },
      minPopulation: {}, terrainProfile: 'island_v1' });
    expect(one.agents).toHaveLength(1);
    const mainland = createWorld({ seed: 2, speciesDir: SPECIES_DIR, initialAgents: { tiger: 2 },
      minPopulation: {}, terrainProfile: 'mainland' });
    expect(mainland.agents.map(agent => agent.sex)).toEqual(['male', 'male']);
  });
  it('has at least two separated reachable, finite inland freshwater basins across seeds', () => {
    for (let seed = -128; seed <= 128; seed++) {
      const patches = buildGrid(seed, 'island_v1');
      const lakes = patches.filter(p => p.surface === 'land' && p.habitat === 'water');
      expect(lakes.length).toBeGreaterThanOrEqual(2);
      expect(lakes.some((a, i) => lakes.slice(i + 1).some(b =>
        Math.abs(a.x - b.x) + Math.abs(a.y - b.y) >= ISLAND_BASIN_SEPARATION_PATCHES))).toBe(true);
      expect(islandFreshwaterBasinIds(patches)).toEqual([]);
      const start = patches.find(landWalkable)!;
      const elephant = makeAgent('elephant', { patchId: start.id, position: { ...patchCentre(start.id), heading: 0 } });
      for (const lake of lakes) {
        expect(lake.waterVolume).toBe(ISLAND_INITIAL_LAKE_WATER_L);
        expect(lake.capacity).toEqual({ grass: 0, browse: 0 });
        expect(planRoute(elephant, lake.id, patches, speciesOf('elephant'))).not.toBeNull();
      }
      expect(buildGrid(seed, 'island_v1')).toEqual(patches);
    }
  });
  it('selects the same legacy promotion IDs after mutable soil moisture changes, without mutating stock', () => {
    const fresh = buildGrid(1, 'island_v1');
    const basinIds = fresh.filter(p => p.surface === 'land' && p.habitat === 'water').map(p => p.id);
    const saved = structuredClone(fresh);
    for (const id of basinIds) { saved[id]!.habitat = 'marsh'; saved[id]!.waterVolume = 1234 + id; }
    const original = structuredClone(saved);
    expect(islandFreshwaterBasinIds(saved)).toEqual(basinIds);
    expect(saved).toEqual(original);
    for (const patch of saved) patch.soilMoisture = patch.id % 2;
    expect(islandFreshwaterBasinIds(saved)).toEqual(basinIds);
    for (const id of basinIds) expect(saved[id]!.waterVolume).toBe(1234 + id);
  });
  it('keeps perennial basin input and dry-season water finite and in the water ledger', () => {
    const patches = buildGrid(1, 'island_v1'), budget = newWaterBudget(patches, 0);
    const lakes = patches.filter(p => p.surface === 'land' && p.habitat === 'water');
    for (let hour = 0; hour < 90 * 24; hour++) updateDrainage(patches, 1, 'dry', budget);
    expect(budget.groundwaterL).toBeGreaterThanOrEqual(lakes.length * 400 * 90 * 24);
    expect(budget.boundaryOutflowL).toBeGreaterThan(0);
    expect(lakes.every(p => p.waterVolume > 0 && Number.isFinite(p.waterVolume))).toBe(true);
    expect(waterBudgetResidual(patches, budget)).toBeCloseTo(0, 3);
  });
  it.each([1, 2, 123, -77])('has an irregular connected core, a coast and an ocean ring for seed %s', seed => {
    const patches = buildGrid(seed, 'island_v1'), land = patches.filter(landWalkable);
    expect(land.length).toBeGreaterThan(100); expect(land.length).toBeLessThan(230);
    expect(patches.some(p => p.surface === 'coast')).toBe(true);
    const seen = new Set([land[0]!.id]), queue = [land[0]!.id];
    while (queue.length) for (const id of patches[queue.shift()!]!.neighbours) {
      if (landWalkable(patches[id]) && !seen.has(id)) { seen.add(id); queue.push(id); }
    }
    expect(seen.size).toBe(land.length);
    for (let i = 0; i <= ISLAND_SEGMENTS; i++) for (const [col, row] of [[0, i], [i, 0], [ISLAND_SEGMENTS, i], [i, ISLAND_SEGMENTS]])
      expect(islandVertexHeight(seed, col!, row!)).toBeLessThan(0);
    for (const p of land) {
      expect(islandPatchSurface(seed, p.id)).toBe('land'); const centre = patchCentre(p.id);
      for (const dx of [-149.9, 0, 149.9]) for (const dz of [-149.9, 0, 149.9])
        expect(islandHeightAt(seed, centre.x + dx, centre.z + dz)).toBeGreaterThanOrEqual(2);
    }
    expect(patches.filter(p => p.surface === 'ocean').every(p => p.waterVolume === 0 && p.capacity.grass === 0 && p.canopyCover === 0)).toBe(true);
  });
  it('rejects mainland exchange, rescue floors and terrain changes to an existing checkpoint', () => {
    expect(() => createWorld({ ...options, minPopulation: { tiger: 1 } })).toThrow('closed population');
    expect(() => createWorld({ ...options, landscape: { regional: { tiger: 2 }, exchangePerDay: 0.1 } })).toThrow('closed population');
    const world = createWorld(options), snapshot = takeSnapshot(world);
    expect(() => restoreSnapshot(snapshot, { ...options, terrainProfile: 'mainland' })).toThrow('terrain profile mismatch');
    snapshot.patches[0]!.surface = 'land';
    expect(() => restoreSnapshot(snapshot, options)).toThrow('checkpoint geometry');
    expect(() => createWorld({ ...options, seed: NaN })).toThrow('safe integer');
  });
  it('never routes an ordinary agent into a coast/ocean cell, including a saved route', () => {
    const p = buildGrid(1, 'island_v1'), start = p.find(a => landWalkable(a) && a.neighbours.some(id => !landWalkable(p[id])))!;
    const destination = start.neighbours.find(id => !landWalkable(p[id]))!;
    const a = makeAgent('chital', { patchId: start.id, position: { ...patchCentre(start.id), heading: 0 } });
    const before = { ...a.position! }; a.journey = { goal: 'wander', destinationPatchId: destination, route: [destination] };
    const result = navigate(a, speciesOf('chital'), p, destination, 'wander', 0, 3600);
    expect(result.unreachable).toBe(true); expect(a.position).toEqual(before); expect(a.journey).toBeUndefined();
  });
  it('stops a hunt at the dry-land boundary without inventing a kill or leaving the land', () => {
    const patches = buildGrid(1, 'island_v1');
    const p = patches.find(p => landWalkable(p) && p.id % 20 < 19 && !landWalkable(patches[p.id + 1]))!;
    const c = patchCentre(p.id), predator = { x: c.x + 130, z: c.z, heading: 0 }, prey = { x: c.x + 149, z: c.z, heading: 0 };
    const result = resolveSpatialHunt({ predatorId: 'tiger_a', preyId: 'chital_b', patchId: p.id, worldTime: 0,
      predator, prey, predatorWalkMs: 1, predatorSprintMs: 10, preySprintMs: 1, preyTrotMs: 1,
      predatorSprintSeconds: 25, preySprintSeconds: 40, contactRadiusM: 1, secondsAvailable: 3600, chaseStaminaCost: 0.3,
      landBoundaryM: (position, heading) => landRayDistance(patches, position, heading),
      contest: { baseSuccess: 1, stalkConcealment: 1, canopyCover: 1, predatorStamina: 1, predatorCondition: 1,
        preyEvasiveness: 0, preyCondition: 1, preyAlert: false, herdSize: 1, commitDistanceM: 10 } }, createRng(3, 'hunt'));
    expect(result.stage).toBe('boundary_escape'); expect(result.killed).toBe(false);
    for (const sample of result.trace.samples) for (const position of [sample.predator, sample.prey])
      expect(landWalkable(patches[patchAtPosition(position)])).toBe(true);
  });
  it('discharges coastal runoff to the ocean without making sea water a freshwater resource', () => {
    const p = buildGrid(1, 'island_v1'), b = newWaterBudget(p, 0);
    for (let i = 0; i < 72; i++) updateDrainage(p, 1, 'monsoon', b);
    expect(b.boundaryOutflowL).toBeGreaterThan(0);
    expect(p.filter(p => p.surface === 'ocean').every(p => p.waterVolume === 0)).toBe(true);
    expect(waterBudgetResidual(p, b)).toBeCloseTo(0, 6);
  });
  it('preserves land-only agents and closed populations across deterministic restart', () => {
    const w = createWorld(options), nutrient = w.totalNutrients();
    const check = () => { for (const a of w.agents) {
      expect(landWalkable(w.patches[a.patchId])).toBe(true);
      expect(islandHeightAt(1, a.position!.x, a.position!.z)).toBeGreaterThan(0);
    } };
    for (let i = 0; i < 120; i++) { w.step(1); check(); }
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(w))), options);
    w.log.take(); restored.log.take();
    for (let i = 0; i < 24; i++) { w.step(1); restored.step(1); check(); }
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(w)); expect(w.log.take()).toEqual(restored.log.take());
    expect(w.waterBudget.animalConsumptionL).toBeGreaterThan(0);
    expect(w.totalNutrients()).toBeCloseTo(nutrient, 6);
  });
  it('upgrades v0.14 rules without silently turning mainland into island', () => {
    const w = createWorld({ ...options, terrainProfile: 'mainland' });
    const old = asLegacySnapshot(takeSnapshot(w), 'sim_0.14.0');
    const next = upgradeV14Snapshot(old);
    expect(next.terrainProfile).toBe('mainland');
    expect(next.patches.some(p => p.floweringGuild)).toBe(true);
    expect(() => restoreSnapshot(next, options)).toThrow('terrain profile mismatch');
  });
});
