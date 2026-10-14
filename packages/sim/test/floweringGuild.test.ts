import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS, WORLD_SECONDS_PER_DAY, WORLD_SECONDS_PER_HOUR, WORLD_SECONDS_PER_YEAR,
  type Patch } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { emptyMicroEcology } from '../src/fields/microEcology.js';
import { establishFloweringGuild, floweringEligible, stepFloweringGuild,
  validateFloweringGuild } from '../src/fields/floweringGuild.js';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { SPECIES_DIR } from './helpers.js';

const H = WORLD_SECONDS_PER_HOUR, D = WORLD_SECONDS_PER_DAY, Y = WORLD_SECONDS_PER_YEAR;
function fixture(): { patch: Patch; micro: ReturnType<typeof emptyMicroEcology> } {
  const source = buildGrid(7).find(p => floweringEligible(p))!;
  const patch = structuredClone(source);
  patch.id = 0; patch.soilMoisture = 1; patch.canopyCover = 0.5;
  const micro = emptyMicroEcology([patch], 0);
  establishFloweringGuild([patch], 0);
  return { patch, micro };
}
function matter(patch: Patch): number {
  const guild = patch.floweringGuild;
  return patch.soilNutrients + (patch.plant.grass + patch.plant.browse
    + (guild?.vegetativeKg ?? 0) + (guild?.bloom?.openKg ?? 0)
    + (guild?.bloom?.visitedKg ?? 0)
    + (guild?.seedBank.reduce((sum, seed) => sum + seed.biomassKg, 0) ?? 0))
      * NUTRIENT_PER_KG_BIOMASS;
}
function advance(patch: Patch, micro: ReturnType<typeof emptyMicroEcology>,
  from: number, through: number): ReturnType<typeof stepFloweringGuild> {
  const events: ReturnType<typeof stepFloweringGuild> = [];
  for (let at = from + H; at <= through; at += H)
    events.push(...stepFloweringGuild([patch], micro, 1, at));
  return events;
}

describe('finite insect-visited flowering guild', () => {
  it('splits existing browse and capacity exactly, without adding patch nutrients', () => {
    const patch = structuredClone(buildGrid(7).find(p => floweringEligible(p))!);
    const before = matter(patch), cap = patch.capacity.browse, browse = patch.plant.browse;
    establishFloweringGuild([patch], 0);
    expect(matter(patch)).toBeCloseTo(before, 10);
    expect(patch.capacity.browse + patch.floweringGuild!.capacityKg).toBe(cap);
    expect(patch.plant.browse + patch.floweringGuild!.vegetativeKg).toBe(browse);
    expect(() => establishFloweringGuild([patch], 0)).toThrow(/already established/);
  });

  it('cannot create visited flowers or seeds without local pollinators', () => {
    const { patch, micro } = fixture();
    const before = matter(patch);
    const events = advance(patch, micro, 279 * D - H, 305 * D);
    expect(events.filter(e => e.type === 'flowering_started')).toHaveLength(1);
    expect(events.find(e => e.type === 'flower_visitation_settled')?.outcome).toBe('failure');
    expect(events.some(e => e.type === 'seeds_matured')).toBe(false);
    expect(patch.floweringGuild!.seedBank).toEqual([]);
    expect(matter(patch)).toBeCloseTo(before, 7);
  });

  it('transfers finite flowers through a visited seed cohort to a later recruit', () => {
    const { patch, micro } = fixture();
    micro.patches[0]!.pollinatorBiomassKg = 1; // controlled positive-path fixture, not a field estimate
    const before = matter(patch);
    const events = advance(patch, micro, 279 * D - H, 305 * D);
    const opening = events.find(e => e.type === 'flowering_started')!;
    const visit = events.find(e => e.type === 'flower_visitation_settled')!;
    const seed = events.find(e => e.type === 'seeds_matured')!;
    expect(opening.biomassKg).toBeGreaterThan(0);
    expect(visit.biomassKg).toBeGreaterThan(0);
    expect(seed.biomassKg).toBeGreaterThan(0);
    expect(seed.biomassKg).toBeLessThanOrEqual(visit.biomassKg * 0.2 + 1e-9);
    expect(patch.floweringGuild!.seedBank).toHaveLength(1);
    validateFloweringGuild(patch, 305 * D);
    const recruits = advance(patch, micro, 305 * D, Y + 11 * D)
      .filter(e => e.type === 'plants_recruited');
    expect(recruits).toHaveLength(1);
    expect(recruits[0]!.biomassKg).toBeGreaterThan(0);
    expect(patch.floweringGuild!.seedBank).toEqual([]);
    expect(matter(patch)).toBeCloseTo(before, 7);
  });

  it('keeps dry blocked seeds finite until explicit expiry and rejects forged stock', () => {
    const { patch, micro } = fixture();
    micro.patches[0]!.pollinatorBiomassKg = 1;
    advance(patch, micro, 279 * D - H, 305 * D);
    patch.soilMoisture = 0.05;
    const before = matter(patch);
    const events = advance(patch, micro, 305 * D, Y + 121 * D);
    expect(events.some(e => e.type === 'plants_recruited')).toBe(false);
    expect(events.some(e => e.type === 'seed_bank_lost')).toBe(true);
    expect(patch.floweringGuild!.seedBank).toEqual([]);
    expect(matter(patch)).toBeCloseTo(before, 7);
    patch.floweringGuild!.vegetativeKg = -1;
    expect(() => validateFloweringGuild(patch, Y + 121 * D)).toThrow(/invalid/);
  });

  it('does not grow an extinct guild ex nihilo', () => {
    const { patch, micro } = fixture();
    patch.floweringGuild!.vegetativeKg = 0;
    const soil = patch.soilNutrients;
    const events = advance(patch, micro, 0, 24 * H);
    expect(events).toEqual([]);
    expect(patch.floweringGuild!.vegetativeKg).toBe(0);
    expect(patch.soilNutrients).toBe(soil);
  });

  // The Congo forest's understory flowers too: in the drier spell its insect-visited plants bloom,
  // and their seed germinates with the long rains. Open bais (grass) and channels do not.
  it('runs in the Congo forest\'s terra firme and flooded forest, from each habitat\'s own browse', () => {
    const congo = buildGrid(7, 'congo_v1');
    const eligible = new Set(congo.filter(floweringEligible).map((p) => p.habitat));
    expect([...eligible].sort()).toEqual(['flooded_forest', 'swamp_forest', 'terra_firme']);
    for (const habitat of ['terra_firme', 'flooded_forest', 'swamp_forest']) {
      const patch = structuredClone(congo.find((p) => p.habitat === habitat)!);
      patch.id = 0; patch.soilMoisture = 1; patch.canopyCover = 0.5;
      const micro = emptyMicroEcology([patch], 0);
      establishFloweringGuild([patch], 0);
      micro.patches[0]!.pollinatorBiomassKg = 1;
      const before = matter(patch);
      const events = advance(patch, micro, 279 * D - H, 305 * D);
      expect(events.some((e) => e.type === 'seeds_matured'), habitat).toBe(true);
      expect(() => validateFloweringGuild(patch, 305 * D), habitat).not.toThrow();
      expect(matter(patch)).toBeCloseTo(before, 7);
    }
  });

  it('settles real island patch events without an observer or animal inventing a visit', () => {
    const world = createWorld({ seed: 7, terrainProfile: 'island_v1', speciesDir: SPECIES_DIR,
      initialAgents: {}, minPopulation: {} });
    const baseline = world.totalNutrients();
    world.step(24 * 372);
    const events = world.log.all();
    expect(events.some(event => event.type === 'flowering_started')).toBe(true);
    expect(events.some(event => event.type === 'flower_visitation_settled')).toBe(true);
    expect(events.some(event => event.type === 'seeds_matured')).toBe(true);
    expect(events.some(event => event.type === 'plants_recruited')).toBe(true);
    expect(events.filter(event => event.type.startsWith('flower') || event.type === 'seeds_matured'
      || event.type === 'plants_recruited').every(event => event.actors.length === 0
        && event.confidence === 'authoritative' && event.worldTime <= world.now())).toBe(true);
    expect(world.totalNutrients()).toBeCloseTo(baseline, 5);
  }, 30_000);

  it('continues mid-bloom through seed and recruitment with identical checkpoint and event IDs', () => {
    const options = { seed: 7, terrainProfile: 'island_v1' as const, speciesDir: SPECIES_DIR,
      initialAgents: {}, minPopulation: {} };
    const continuous = createWorld(options);
    continuous.step(24 * 281);
    expect(continuous.patches.some(patch => patch.floweringGuild?.bloom)).toBe(true);
    const checkpoint = takeSnapshot(continuous);
    continuous.log.take();
    const resumed = restoreSnapshot(JSON.parse(JSON.stringify(checkpoint)), options);
    continuous.step(24 * 91); resumed.step(24 * 91);
    expect(takeSnapshot(resumed)).toEqual(takeSnapshot(continuous));
    expect(resumed.log.all()).toEqual(continuous.log.all());
  }, 30_000);
});
