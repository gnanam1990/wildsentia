import { describe, expect, it } from 'vitest';
import { initialPosition, patchAtPosition, isMovementTrace, movementAt } from '@vana/shared';
import { navigate, planRoute } from '../src/agents/navigation.js';
import { buildGrid } from '../src/grid.js';
import { makeAgent, speciesOf } from './helpers.js';

function fixture() {
  const patches = buildGrid(1);
  for (const p of patches) p.habitat = 'grassland';
  const cfg = structuredClone(speciesOf('sambar'));
  cfg.locomotion.walkMs = 1; cfg.locomotion.trotMs = 2; cfg.locomotion.sprintMs = 4; cfg.locomotion.sprintStaminaS = 2;
  cfg.locomotion.terrainCost.grassland = 1;
  const agent = makeAgent('sambar', { id: 'traveller', position: initialPosition('traveller', 0),
    drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
  return { patches, cfg, agent };
}
describe('authoritative terrain navigation', () => {
  it('does not change patches or teleport when only ten metres are affordable', () => {
    const { agent, cfg, patches } = fixture(); const start = { ...agent.position! };
    const result = navigate(agent, cfg, patches, 1, 'wander', 0, 10);
    expect(result.distanceM).toBeCloseTo(10);
    expect(Math.hypot(agent.position!.x - start.x, agent.position!.z - start.z)).toBeCloseTo(10);
    expect(result.seconds).toBe(10); expect(result.trace.completed).toBe(false);
    expect(agent.patchId).toBe(0); expect(agent.journey?.destinationPatchId).toBe(1);
  });
  it('follows only cardinal waypoints and reaches a distant destination within its budget', () => {
    const { agent, cfg, patches } = fixture();
    const route = planRoute(agent, 24, patches, cfg)!;
    let previous = agent.patchId;
    for (const next of route) { expect(patches[previous]!.neighbours).toContain(next); previous = next; }
    expect(route.at(-1)).toBe(24);
    const result = navigate(agent, cfg, patches, 24, 'find_water', 0, 10_000);
    expect(result.trace.completed).toBe(true); expect(agent.journey).toBeUndefined();
    expect(agent.patchId).toBe(24);
    expect(agent.position!.x).toBeCloseTo(initialPosition(agent.id, 24).x);
    expect(result.seconds).toBeCloseTo(result.distanceM);
    expect(result.seconds).toBeLessThan(10_000);
  });
  it('continues a JSON-persisted journey without replacing its endpoint or path', () => {
    const full = fixture(); const split = fixture();
    navigate(full.agent, full.cfg, full.patches, 24, 'find_water', 0, 350);
    navigate(split.agent, split.cfg, split.patches, 24, 'find_water', 0, 180);
    const restored = JSON.parse(JSON.stringify(split.agent));
    navigate(restored, split.cfg, split.patches, 24, 'find_water', 180, 170);
    expect(restored.journey).toEqual(full.agent.journey);
    expect(restored.patchId).toBe(full.agent.patchId);
    expect(restored.position.x).toBeCloseTo(full.agent.position!.x, 8);
    expect(restored.position.z).toBeCloseTo(full.agent.position!.z, 8);
  });
  it('routes around expensive terrain instead of blindly reducing Manhattan distance', () => {
    const { agent, cfg, patches } = fixture();
    patches[1]!.habitat = 'rock'; cfg.locomotion.terrainCost.rock = 100;
    const route = planRoute(agent, 2, patches, cfg)!;
    expect(route).not.toContain(1); expect(route.at(-1)).toBe(2);
    const reordered = structuredClone(patches);
    for (const p of reordered) p.neighbours.reverse();
    expect(planRoute(agent, 2, reordered, cfg)).toEqual(route);
  });
  it('reports unreachable terrain and never fabricates a destination', () => {
    const { agent, cfg, patches } = fixture();
    for (const next of patches[0]!.neighbours) patches[next]!.habitat = 'rock';
    cfg.locomotion.terrainCost.rock = Infinity;
    const before = { ...agent.position! };
    expect(navigate(agent, cfg, patches, 24, 'wander', 0, 3600).unreachable).toBe(true);
    expect(agent.position).toEqual(before); expect(agent.patchId).toBe(0);
  });
  it('charges each terrain section and records the real boundary crossing', () => {
    const { agent, cfg, patches } = fixture();
    patches[1]!.habitat = 'rock'; cfg.locomotion.terrainCost.rock = 2;
    agent.position = { x: 149, z: 0, heading: 0 };
    const result = navigate(agent, cfg, patches, 1, 'wander', 0, 10);
    expect(agent.patchId).toBe(1);
    const boundary = result.trace.samples[1]!;
    expect(boundary.position.x).toBeCloseTo(150);
    expect(result.distanceM).toBeCloseTo(boundary.seconds + (10 - boundary.seconds) / 2);
    expect(patchAtPosition(agent.position!)).toBe(agent.patchId);
  });
  it('uses body-size and fatigue scaling, and transitions from sprint to trot', () => {
    const small = fixture(); small.agent.massKg /= 4;
    expect(navigate(small.agent, small.cfg, small.patches, 1, 'wander', 0, 10).distanceM).toBeCloseTo(5);
    const tired = fixture(); tired.agent.drives.fatigue = 1;
    expect(navigate(tired.agent, tired.cfg, tired.patches, 1, 'wander', 0, 10).distanceM).toBeCloseTo(5);
    const fleeing = fixture();
    const result = navigate(fleeing.agent, fleeing.cfg, fleeing.patches, 1, 'flee', 0, 10, true);
    expect(result.sprintSeconds).toBe(2); expect(result.distanceM).toBeCloseTo(2 * 4 + 8 * 2);
    expect(result.trace.samples.some((s) => s.seconds === 2)).toBe(true);
  });
  it('replans a stale route after another authoritative interaction moves the actor', () => {
    const { agent, cfg, patches } = fixture();
    navigate(agent, cfg, patches, 24, 'wander', 0, 1);
    agent.patchId = 100; agent.position = initialPosition(agent.id, 100);
    const result = navigate(agent, cfg, patches, 24, 'wander', 1, 1);
    expect(result.distanceM).toBeCloseTo(1); expect(agent.patchId).toBe(100);
  });

  it('records vulture takeoff, cruise altitude and landing without a ground-route teleport', () => {
    const patches = buildGrid(9);
    for (const p of patches) p.habitat = 'grassland';
    const cfg = structuredClone(speciesOf('vulture'));
    const agent = makeAgent('vulture', { id: 'vulture-flight', position: initialPosition('vulture-flight', 0),
      drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
    const partial = navigate(agent, cfg, patches, 24, 'scavenge', 0, 5);
    expect(partial.trace.completed).toBe(false);
    expect(isMovementTrace(partial.trace)).toBe(true);
    expect(partial.trace.samples.at(-1)!.altitudeM).toBeGreaterThan(0);
    expect(agent.locomotionMode).toBe('flight');
    const full = navigate(agent, cfg, patches, 24, 'scavenge', 5 * 3600, 10_000);
    expect(full.trace.completed).toBe(true);
    expect(full.trace.samples.at(-1)!.altitudeM).toBe(0);
    expect(agent.altitudeM).toBeUndefined();
    expect(agent.locomotionMode).toBeUndefined();
  });

  it('records the airborne interval of a flight completed within one tick, including short hops', () => {
    const patches = buildGrid(9), cfg = structuredClone(speciesOf('vulture'));
    for (const destination of [0, 24]) {
      const agent = makeAgent('vulture', { id: 'flight-audit', position: initialPosition('flight-audit', 0),
        drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
      const target = destination === 0 ? { ...agent.position!, x: agent.position!.x + 1 } : initialPosition(agent.id, destination);
      const gap = Math.hypot(target.x - agent.position!.x, target.z - agent.position!.z);
      const result = navigate(agent, cfg, patches, destination, 'scavenge', 0, 3600, false, target);
      expect(result.trace.completed).toBe(true); expect(isMovementTrace(result.trace)).toBe(true);
      expect(result.trace.samples.length).toBeGreaterThan(2);
      expect(result.seconds).toBeCloseTo(gap / cfg.locomotion.sprintMs);
      expect(result.distanceM).toBeCloseTo(gap);
      expect(movementAt(result.trace, result.seconds / 2).altitudeM).toBeGreaterThan(0);
      if (destination === 0) expect(movementAt(result.trace, result.seconds / 2).altitudeM).toBeLessThan(1);
      expect(movementAt(result.trace, 0).altitudeM).toBe(0);
      expect(movementAt(result.trace, result.seconds).altitudeM).toBe(0);
      expect(agent.altitudeM).toBeUndefined();
    }
  });
});
