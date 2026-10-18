import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONGO_GRID, treeAnchorForPatch, treeAnchorGeometry, treeClimbGoal } from '@vana/shared';
import { createWorld } from '../src/world.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

// The agile mangabey lives in the canopy: it rests and sleeps up its patch's tree and comes down
// to forage and drink (on the ground some 12-22% of its time; docs/2026-10-14-congo-phase-b-research.md).
describe('a canopy dweller lives up its tree', () => {
  it('rests aloft and comes down to forage, most hours in the tree', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { agile_mangabey: 60 }, minPopulation: {}, retainEvents: 'all' });
    let aloft = 0, hours = 0;
    for (let h = 0; h < 24 * 6; h++) {
      world.step(1);
      for (const a of world.agents) if (a.alive && a.speciesId === 'agile_mangabey'
        && a.dependentOn === null && a.pregnantSince === null) { hours++; if ((a.altitudeM ?? 0) > 0) aloft++; }
    }
    expect(aloft / hours).toBeGreaterThan(0.6);

    const climbs = world.log.all().filter((e) => e.type === 'tree_climbed');
    const roosts = climbs.filter((e) => e.conditions.reason === 'roost');
    const forays = climbs.filter((e) => e.conditions.reason === 'forage');
    expect(roosts.length).toBeGreaterThan(0);
    expect(forays.length).toBeGreaterThan(0);
    for (const e of roosts) {
      expect(e.conditions.direction).toBe('ascend');
      expect(e.goal).toBe('rest');
      expect(e.movement!.goal).toBe('rest');
      expect(treeAnchorForPatch(CONGO_GRID, world.patches[e.movement!.destinationPatchId]!)).not.toBeNull();
    }
    for (const e of forays) { expect(e.conditions.direction).toBe('descend'); expect(e.goal).toBe('rest'); }
  }, 240_000);

  // The owner: monkeys hold the trees and travel through them. A troop moves tree to tree through
  // the canopy and eats fruit and leaves up there; it comes down for roots and water.
  it('travels tree to tree through the canopy and feeds up there', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: { agile_mangabey: 60 }, minPopulation: {}, retainEvents: 'all' });
    let aloft = 0, hours = 0;
    for (let h = 0; h < 24 * 6; h++) {
      world.step(1);
      for (const a of world.agents) if (a.alive && a.speciesId === 'agile_mangabey'
        && a.dependentOn === null && a.pregnantSince === null) { hours++; if ((a.altitudeM ?? 0) > 0) aloft++; }
    }
    expect(aloft / hours).toBeGreaterThan(0.8);
    const events = world.log.all();
    const hops = events.filter((e) => e.type === 'tree_climbed' && e.conditions.direction === 'traverse');
    // Some 1-1.5 km a day per troop: hundreds of crossings in six days for sixty animals.
    expect(hops.length).toBeGreaterThan(300);
    for (const e of hops) {
      const from = e.conditions.from as number, to = e.movement!.destinationPatchId;
      expect(to).not.toBe(from);
      expect(Math.abs((from % 160) - (to % 160))).toBeLessThanOrEqual(1);
      expect(Math.abs(Math.floor(from / 160) - Math.floor(to / 160))).toBeLessThanOrEqual(1);
      expect(treeAnchorForPatch(CONGO_GRID, world.patches[to]!)).not.toBeNull();
      expect(e.goal).toBe(treeClimbGoal('traverse', e.conditions.reason));
      expect(e.conditions.treeAnchorId).toBe(treeAnchorGeometry(CONGO_GRID, to)!.id);
      const samples = e.movement!.samples, a = treeAnchorGeometry(CONGO_GRID, from)!, b = treeAnchorGeometry(CONGO_GRID, to)!;
      // Aloft the whole way, from one trunk to the other.
      for (const s of samples) expect(s.altitudeM!).toBeGreaterThan(0);
      expect(Math.hypot(samples[0]!.position.x - a.x, samples[0]!.position.z - a.z)).toBeLessThan(1e-6);
      expect(Math.hypot(samples.at(-1)!.position.x - b.x, samples.at(-1)!.position.z - b.z)).toBeLessThan(1e-6);
      expect(e.outcome).toBe('success');
    }
    const fedAloft = events.filter((e) => e.type === 'fed' && e.conditions.where === 'canopy');
    expect(fedAloft.length).toBeGreaterThan(20);
    for (const e of fedAloft) { expect(e.effects.kg!).toBeGreaterThan(0); expect(e.effects.rootsKg).toBeUndefined(); }
  }, 240_000);
});
