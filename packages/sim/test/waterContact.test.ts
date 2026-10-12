import { describe, expect, it } from 'vitest';
import { atWaterAccess, createRng, isMovementTrace, positionInPatch, waterAccessPosition, waterContactPosition,
  WATER_CONTACT_RADIUS_M, type WorldEvent } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { executeGoal } from '../src/agents/behaviours.js';
import { perceive } from '../src/agents/perception.js';
import { EventLog } from '../src/events/log.js';
import { createWorld, SIM_VERSION } from '../src/world.js';
import { takeSnapshot, restoreSnapshot, upgradeV9Snapshot } from '../src/snapshot.js';
import { makeAgent, makeServices, makeView, speciesOf, SPECIES_DIR } from './helpers.js';
import { asLegacySnapshot } from './legacySnapshot.js';

function fixture(seconds: number, patchId = 0) {
  const patches = buildGrid(1);
  for (const p of patches) { p.habitat = 'grassland'; p.waterVolume = 1000; }
  const species = structuredClone(speciesOf('sambar'));
  species.locomotion.walkMs = 1; species.locomotion.terrainCost.grassland = 1;
  const agent = makeAgent('sambar', { id: 'drinker', patchId,
    position: { ...waterAccessPosition(patchId), x: waterAccessPosition(patchId).x + 100 },
    drives: { hunger: 0, thirst: 0.9, fatigue: 0, fear: 0 } });
  const view = makeView(patches, [agent]), log = new EventLog(1, SIM_VERSION);
  const ctx = { agent, species, patches, view, log, rng: createRng(1, 'contact'), services: makeServices([]),
    percept: perceive(agent, species, view), choice: { goal: 'find_water' as const, score: 1, alternative: null },
    hours: seconds / 3600, worldTime: 0 };
  return { agent, species, patches, log, ctx };
}
const drank = (events: readonly WorldEvent[]) => events.find((e) => e.type === 'drank');

describe('local water access contact', () => {
  it('defines stable in-bounds sources and approach slots without an actor-specific water supply', () => {
    for (let id = 0; id < 400; id++) {
      const source = waterAccessPosition(id), slot = waterContactPosition('sambar', id);
      expect(positionInPatch(source, id)).toBe(true); expect(positionInPatch(slot, id)).toBe(true);
      expect(atWaterAccess(slot, id)).toBe(true); expect(waterContactPosition('sambar', id)).toEqual(slot);
      expect(waterContactPosition('gaur', id)).not.toEqual(slot);
    }
    for (const bad of [-1, 400, NaN, 1.5]) expect(() => waterAccessPosition(bad)).toThrow();
  });

  it('cannot drink remotely from its own patch; moves only the affordable distance', () => {
    const s = fixture(10), before = { ...s.agent.position! }, water = s.patches[0]!.waterVolume;
    executeGoal(s.ctx);
    expect(drank(s.log.all())).toBeUndefined(); expect(s.patches[0]!.waterVolume).toBe(water);
    expect(s.agent.drives.thirst).toBe(0.9); expect(s.agent.state).toBe('travelling');
    expect(Math.hypot(s.agent.position!.x - before.x, s.agent.position!.z - before.z)).toBeCloseTo(10);
    const event = s.log.all().find((e) => e.type === 'moved')!;
    expect(isMovementTrace(event.movement)).toBe(true); expect(event.movement!.completed).toBe(false);
  });

  it('requires remaining drinking time, caps the amount and records contact plus causal approach', () => {
    const full = fixture(3600); executeGoal(full.ctx);
    const approach = full.log.all().find((e) => e.type === 'moved')!, arrival = approach.effects.durationSeconds!;
    const exact = fixture(arrival); executeGoal(exact.ctx); expect(drank(exact.log.all())).toBeUndefined();
    const brief = fixture(arrival + 1); executeGoal(brief.ctx);
    const event = drank(brief.log.all())!;
    expect(event).toBeDefined(); expect(atWaterAccess(event.position!, event.patchId)).toBe(true);
    expect(event.effects.litres).toBeCloseTo(brief.species.diet.waterNeedLPerDay * 4 / 3600);
    expect(1000 - brief.patches[0]!.waterVolume).toBeCloseTo(event.effects.litres!);
    expect(event.causalParents).toEqual([brief.log.all().find((e) => e.type === 'moved')!.id]);
    expect(event.conditions.arrivalWorldTime).toBeCloseTo(arrival);
    expect(event.conditions.drinkingSeconds).toBeCloseTo(1);
    expect(event.conditions.contactRadiusM).toBe(WATER_CONTACT_RADIUS_M);
    expect(event.worldTime).toBe(Math.floor(arrival + 1));
    expect(brief.agent.position).toEqual(event.position);
  });

  it('does not draw RNG, move a drinker already in contact, or consume at zero time/dry sources', () => {
    const s = fixture(60); s.agent.position = waterContactPosition(s.agent.id, 0);
    const before = { ...s.agent.position! }, state = s.ctx.rng.exportState(); executeGoal(s.ctx);
    expect(s.ctx.rng.exportState()).toEqual(state); expect(s.agent.position!.x).toBe(before.x);
    expect(s.agent.position!.z).toBe(before.z); expect(s.log.all().some((e) => e.type === 'moved')).toBe(false);
    for (const seconds of [0, 60]) {
      const unavailable = fixture(seconds); unavailable.ctx.percept.bestWater = null;
      if (seconds) unavailable.patches[0]!.waterVolume = 0;
      executeGoal(unavailable.ctx); expect(drank(unavailable.log.all())).toBeUndefined();
    }
  });

  it('approaches the remote source itself and never spends travel time twice', () => {
    const s = fixture(3600); s.patches[0]!.waterVolume = 0; s.ctx.percept.bestWater = { patchId: 2, litres: 1000 };
    executeGoal(s.ctx);
    const event = drank(s.log.all())!, move = s.log.all().find((e) => e.type === 'moved')!;
    expect(event.patchId).toBe(2); expect(atWaterAccess(event.position!, 2)).toBe(true);
    expect(move.movement!.samples.at(-1)!.position.x).toBeCloseTo(waterContactPosition(s.agent.id, 2).x);
    expect(Number(event.conditions.drinkingSeconds) + move.effects.durationSeconds!).toBeCloseTo(3600);
    expect(s.log.all().filter((e) => e.type === 'moved')).toHaveLength(1);
  });

  it('drinks from a lake at its shore with dry land, not standing out in the lake', () => {
    // chital_01d9 drank standing inside island_v2 patch 367, a lake patch, 30-95 m from any land.
    const s = fixture(3600, 21);
    s.patches[21]!.habitat = 'water'; s.patches[20]!.habitat = 'water'; s.patches[1]!.habitat = 'water';
    s.agent.position = { x: 21 % 20 * 300, z: 300, heading: 0 }; // the middle of the lake
    executeGoal(s.ctx);
    const event = drank(s.log.all())!;
    expect(event.patchId).toBe(21);
    expect(atWaterAccess(event.position!, 21, s.patches)).toBe(true);
    // The dry sides are east (patch 22) and south (patch 41): the drinker stands at one of them.
    const east = 300 + 150 - event.position!.x, south = 300 + 150 - event.position!.z;
    expect(Math.min(east, south)).toBeLessThan(5);
    expect(s.agent.position).toEqual(event.position);
  });

  it('continues a partially completed water approach identically across a JSON world checkpoint', () => {
    const options = { seed: 8, speciesDir: SPECIES_DIR, initialAgents: { sambar: 4 }, minPopulation: {} };
    const world = createWorld(options), s = fixture(10);
    world.agents[0] = s.agent; world.patches.splice(0, world.patches.length, ...s.patches);
    executeGoal(s.ctx);
    const snapshot = takeSnapshot(world), old = asLegacySnapshot(snapshot, 'sim_0.9.0');
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const original = JSON.stringify(old), upgraded = upgradeV9Snapshot(old);
    expect(upgraded.simVersion).toBe(SIM_VERSION); expect(JSON.stringify(old)).toBe(original);
    expect(() => upgradeV9Snapshot({ ...old, simVersion: 'sim_0.8.0' })).toThrow();
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snapshot)), options);
    const resumed = { ...s.ctx, agent: restored.agents[0]!, patches: restored.patches,
      view: makeView(restored.patches, restored.agents), hours: 1, worldTime: 10, log: new EventLog(1, SIM_VERSION) };
    const continuous = { ...s.ctx, hours: 1, worldTime: 10, log: new EventLog(1, SIM_VERSION) };
    executeGoal(resumed); executeGoal(continuous);
    expect(resumed.agent).toEqual(continuous.agent); expect(resumed.patches[0]).toEqual(continuous.patches[0]);
    expect(resumed.log.all()).toEqual(continuous.log.all());
  });
});
