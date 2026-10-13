import { describe, expect, it } from 'vitest';
import { createRng, isWorldPosition, patchAtPosition } from '@vana/shared';
import { resolveSpatialHunt, type SpatialHuntInput } from '../src/agents/encounters.js';
import { ISLAND_GRID } from '@vana/shared';

const input: SpatialHuntInput = { grid: ISLAND_GRID,
  predatorId: 'tiger_a', preyId: 'sambar_a', patchId: 0, worldTime: 3600,
  predator: { x: 0, z: 0, heading: 0 }, prey: { x: 20, z: 0, heading: 0 },
  predatorWalkMs: 1, predatorSprintMs: 10, preySprintMs: 1, preyTrotMs: 0.5,
  predatorSprintSeconds: 25, preySprintSeconds: 40, contactRadiusM: 1,
  secondsAvailable: 3600, chaseStaminaCost: 0.34,
  contest: { baseSuccess: 1, stalkConcealment: 1, canopyCover: 1, predatorStamina: 1,
    predatorCondition: 1, preyEvasiveness: 0, preyCondition: 1, preyAlert: false,
    herdSize: 1, commitDistanceM: 10 },
};
const run = (changes: Partial<SpatialHuntInput> = {}) => resolveSpatialHunt({ grid: ISLAND_GRID, ...input, ...changes }, createRng(3, 'encounter'));
describe('authoritative spatial hunt', () => {
  it('records approach, chase and actual contact before permitting a kill, without mutating inputs', () => {
    const before = structuredClone(input); const result = run();
    expect(input).toEqual(before); expect(result.killed).toBe(true);
    expect(result.trace.samples.map((s) => s.phase)).toEqual(['approach', 'stalk', 'chase', 'contact']);
    const last = result.trace.samples.at(-1)!;
    expect(last.seconds).toBeCloseTo(11);
    expect(Math.hypot(last.predator.x - last.prey.x, last.predator.z - last.prey.z)).toBeCloseTo(1);
    expect(result.distanceAtCommitM).toBeCloseTo(10);
  });
  it('cannot kill prey it has not had enough time to approach', () => {
    const result = run({ secondsAvailable: 2 });
    expect(result.stage).toBe('approaching'); expect(result.killed).toBe(false);
    expect(result.trace.samples.at(-1)!.predator.x).toBe(2);
  });
  it('cannot kill faster prey even with a guaranteed successful probability roll', () => {
    const result = run({ preySprintMs: 12 });
    expect(result.killed).toBe(false);
    expect(result.trace.samples.some((s) => s.phase === 'contact')).toBe(false);
  });
  it('stops when stamina is exhausted instead of extending the chase to manufacture contact', () => {
    const result = run({ predatorSprintSeconds: 0.1 });
    expect(result.stage).toBe('chase_abandoned'); expect(result.killed).toBe(false);
    expect(result.trace.samples.at(-1)!.seconds).toBeCloseTo(10.1);
  });
  it('crosses administrative patch boundaries without inventing a wall or an escape', () => {
    const result = run({ predator: { x: 130, z: 0, heading: 0 }, prey: { x: 149, z: 0, heading: 0 } });
    expect(result.killed).toBe(true);
    expect(patchAtPosition(ISLAND_GRID, result.trace.samples.at(-1)!.prey)).toBe(1);
  });
  it('does not turn the world boundary into a wall trapping prey', () => {
    const result = run({ patchId: 19, predator: { x: 5830, z: 0, heading: 0 }, prey: { x: 5849, z: 0, heading: 0 } });
    expect(result.stage).toBe('boundary_escape'); expect(result.killed).toBe(false);
    for (const sample of result.trace.samples) {
      expect(isWorldPosition(ISLAND_GRID, sample.predator)).toBe(true); expect(isWorldPosition(ISLAND_GRID, sample.prey)).toBe(true);
    }
  });
  it('lets an alerted prey flee without marking the stationary predator as chasing', () => {
    const rng = createRng(3, 'alert'); rng.bool = () => true;
    const result = resolveSpatialHunt(input, rng);
    expect(result.stage).toBe('prey_alerted'); expect(result.killed).toBe(false);
    expect(result.trace.samples.at(-1)!.phase).toBe('escape');
    expect(result.trace.samples.some((s) => s.phase === 'chase')).toBe(false);
  });
  it('records failed physical capture as escape, never a kill', () => {
    const result = run({ contest: { ...input.contest, baseSuccess: 0 } });
    expect(result.killed).toBe(false); expect(result.stage).toBe('escaped');
    expect(result.trace.samples.map((s) => s.phase)).toContain('contact');
    const last = result.trace.samples.at(-1)!;
    expect(last.prey.x - last.predator.x).toBeGreaterThan(input.contactRadiusM);
  });
  it('is deterministic, time-monotone and within speed limits', () => {
    const a = run(); expect(a).toEqual(run());
    const samples = a.trace.samples;
    for (let i = 1; i < samples.length; i++) {
      const p = samples[i - 1]!; const q = samples[i]!; const dt = q.seconds - p.seconds;
      expect(dt).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(q.predator.x-p.predator.x, q.predator.z-p.predator.z)).toBeLessThanOrEqual(input.predatorSprintMs * dt + 1e-7);
      expect(Math.hypot(q.prey.x-p.prey.x, q.prey.z-p.prey.z)).toBeLessThanOrEqual(input.preySprintMs * dt + 1e-7);
    }
  });
  it('rejects malformed positions, nonfinite rules and invalid time budgets', () => {
    expect(() => run({ secondsAvailable: 0 })).toThrow();
    expect(() => run({ predator: { x: NaN, z: 0, heading: 0 } })).toThrow();
    expect(() => run({ contest: { ...input.contest, predatorStamina: NaN } })).toThrow();
  });
});
