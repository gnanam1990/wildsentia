import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS, landWalkable, positionInPatch, type WorldEvent } from '@vana/shared';
import { createWorld, type World } from '../src/world.js';
import { restoreSnapshot, takeSnapshot, upgradeV32Snapshot } from '../src/snapshot.js';
import { SPECIES_DIR } from './helpers.js';

const island = (initialAgents: Record<string, number>, seed = 3) => ({ seed, speciesDir: SPECIES_DIR, initialAgents,
  minPopulation: {}, terrainProfile: 'island_v1' as const, retainEvents: 'all' as const });
const arrivals = (world: World): WorldEvent[] => world.log.all().filter(e => e.type === 'immigration');
/** Test-only: make the configured crossing certain each eligible day so the rule is visible fast. */
function certain(world: World, speciesId: string, minDaysBetween: number, whenLivingAtMost = 1): void {
  world.species.get(speciesId)!.islandArrival = { whenLivingAtMost, dailyProbability: 1, minDaysBetween };
}
const days = (world: World, n: number) => { for (let i = 0; i < n * 24; i++) world.step(1); };

describe('rare recorded island arrivals (sim_0.33.0)', () => {
  it('brings one adult ashore as a positioned, authoritative immigration event whose body the ledger imports', () => {
    const world = createWorld(island({ tiger: 1 }));
    certain(world, 'tiger', 30);
    const nutrients = world.totalNutrients();
    days(world, 1);
    const [event] = arrivals(world);
    expect(arrivals(world)).toHaveLength(1);
    expect(event).toMatchObject({ worldTime: 86_400, outcome: 'success', confidence: 'authoritative', causalParents: [],
      conditions: { species: 'tiger', route: 'island_crossing', trigger: 'small_population', livingBefore: 1, whenLivingAtMost: 1 } });
    const arrived = world.agents.find(a => a.id === event!.actors[0])!;
    expect(arrived).toMatchObject({ speciesId: 'tiger', generation: 0, motherId: null, dependentOn: null, bornAt: 86_400 });
    expect(arrived.ageDays).toBeGreaterThanOrEqual(world.species.get('tiger')!.lifecycle.sexualMaturityDays);
    // Ashore: on land touching the sea, at the recorded position.
    const patch = world.patches[event!.patchId]!;
    expect(landWalkable(patch)).toBe(true);
    expect(patch.neighbours.some(id => ['ocean', 'coast'].includes(String(world.patches[id]!.surface)))).toBe(true);
    expect(positionInPatch(event!.position, event!.patchId)).toBe(true);
    expect(event!.effects.massKg).toBe(arrived.massKg);
    // Conserving: the arrival's body is recorded as imported, so the ledger total is unchanged.
    expect(world.ledger.imported).toBeCloseTo(arrived.massKg * NUTRIENT_PER_KG_BIOMASS, 9);
    expect(world.totalNutrients()).toBeCloseTo(nutrients, 6);
    expect(world.islandArrivals.tiger).toBe(86_400);
  });

  it('arrives only while the species is scarce, at most once per configured interval', () => {
    const plenty = createWorld(island({ tiger: 2 }));
    certain(plenty, 'tiger', 30);
    days(plenty, 5);
    expect(arrivals(plenty)).toHaveLength(0);
    const scarce = createWorld(island({ jackal: 0 }));
    certain(scarce, 'jackal', 10, 1);
    days(scarce, 25);
    const times = arrivals(scarce).map(e => e.worldTime / 86_400);
    expect(arrivals(scarce).map(e => e.conditions.trigger)).toEqual(['locally_extinct', 'small_population']);
    // Arrivals only while at most one lives, ten days apart; the second makes two and stops them.
    expect(times).toEqual([1, 11]);
  });

  it('never brings species that cannot cross, nor anything to the mainland', () => {
    const world = createWorld(island({ chital: 0, dhole: 0, langur: 0 }));
    days(world, 10);
    expect(arrivals(world)).toHaveLength(0);
    const mainland = createWorld({ seed: 3, speciesDir: SPECIES_DIR, initialAgents: { tiger: 1 }, minPopulation: {} });
    certain(mainland, 'tiger', 1);
    days(mainland, 3);
    expect(arrivals(mainland)).toHaveLength(0);
  });

  it('is decided by the seed, not by chance or by the world\'s random stream, and survives a checkpoint', () => {
    const run = () => { const w = createWorld(island({ tiger: 1, jackal: 1 }, 11)); certain(w, 'tiger', 4); certain(w, 'jackal', 3, 2); return w; };
    const a = run(), b = run();
    days(a, 6); days(b, 6);
    expect(arrivals(a).map(e => [e.worldTime, e.actors[0], e.patchId])).toEqual(arrivals(b).map(e => [e.worldTime, e.actors[0], e.patchId]));
    // Real daily draws: with the configured 1/180 tiger probability a lone tiger waits.
    const real = createWorld(island({ tiger: 1 }));
    days(real, 3);
    expect(arrivals(real)).toHaveLength(0);
    // The last-arrival clock is checkpointed, so a restored world keeps the same spacing.
    const saved = JSON.parse(JSON.stringify(takeSnapshot(a)));
    expect(saved.islandArrivals).toEqual(a.islandArrivals);
    const restored = restoreSnapshot(saved, island({ tiger: 1, jackal: 1 }, 11));
    certain(restored, 'tiger', 4); certain(restored, 'jackal', 3, 2);
    days(a, 5); days(restored, 5);
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(a));
    expect(() => restoreSnapshot({ ...saved, islandArrivals: { chital: 10 } }, island({}, 11))).toThrow(/island arrival/);
    expect(() => restoreSnapshot({ ...saved, islandArrivals: { tiger: saved.worldTime + 1 } }, island({}, 11))).toThrow(/island arrival/);
  });

  it('opts a real v0.32 world in without inventing an arrival or rewriting its state', () => {
    const current = takeSnapshot(createWorld(island({ tiger: 1 })));
    const old = structuredClone(current); old.simVersion = 'sim_0.32.0';
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, island({ tiger: 1 }))).toThrow(/version/);
    const upgraded = upgradeV32Snapshot(old);
    expect(upgraded).toEqual(current);
    expect(upgraded.islandArrivals).toBeUndefined();
    expect(old).toEqual(before);
    expect(() => upgradeV32Snapshot(upgraded)).toThrow(/only sim_0.32.0/);
  });
});
