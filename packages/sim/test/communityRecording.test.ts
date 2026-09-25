import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { isCommunityState, humanMotionAt, MAX_HUMAN_MOTION_SAMPLES } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { stepCommunity } from '../src/community.js';
import { takeSnapshot, restoreSnapshot } from '../src/snapshot.js';

const options = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: {}, minPopulation: {}, communityProfile: 'household_v1' as const };
const world = () => createWorld(options);
describe('executed household journey recording', () => {
  it('captures actual paid corners, arrival and work windows instead of diagonal interpolation or future waypoints', () => {
    const w = world(), c = w.community!, p = c.people[0]!, start = { ...p.position };
    const corner = { ...start, x: start.x + 10 }, destination = { ...corner, z: corner.z + 10 };
    p.task = { kind: 'gather_food', phase: 'travel', destination, remainingSeconds: 900, startedAt: 0, eventId: 'fixture_saved_attempt',
      journey: { destinationPatchId: p.patchId, waypoints: [corner, destination] } };
    stepCommunity(c, w.patches, w.waterBudget, 0, 60, w.log, w.microEcology);
    expect(isCommunityState(c)).toBe(true); const track = c.motion!.tracks[0]!;
    const turn = track.samples.find(s => s.position.x === corner.x && s.position.z === corner.z)!;
    expect(turn.seconds).toBeGreaterThan(0); expect(turn.seconds).toBeLessThan(60);
    const firstLeg = humanMotionAt(track.samples, turn.seconds / 2);
    expect(firstLeg.position.x).toBeCloseTo(start.x + 5); expect(firstLeg.position.z).toBe(start.z); expect(firstLeg.moving).toBe(true);
    const arrival = track.samples.find(s => s.phase === 'work')!;
    expect(arrival.position).toMatchObject({ x: destination.x, z: destination.z });
    expect(humanMotionAt(track.samples, arrival.seconds + 1).moving).toBe(false);
    expect(humanMotionAt(track.samples, arrival.seconds + 1).action).toBe('gather_food');
    expect(track.samples.at(-1)!.seconds).toBe(60); expect(track.samples.at(-1)!.position).toEqual(p.position);
    expect(p.inventory.foodKg).toBe(0); // Arrival/animation alone did not complete the 900s work.
    const partial = world(), q = partial.community!.people[0]!;
    q.task = { kind: 'gather_food', phase: 'travel', destination, remainingSeconds: 900, startedAt: 0, eventId: 'fixture_saved_attempt',
      journey: { destinationPatchId: q.patchId, waypoints: [corner, destination] } };
    stepCommunity(partial.community!, partial.patches, partial.waterBudget, 0, 1, partial.log, partial.microEcology);
    const samples = partial.community!.motion!.tracks[0]!.samples;
    expect(samples.every(s => s.position.x < corner.x)).toBe(true); expect(samples.at(-1)!.seconds).toBe(1);
  });
  it('records death at its actual transition, not at the start of a recording or from the newer final state', () => {
    const w = world(), c = w.community!, p = c.people[0]!; p.ageDays = 91 * 360; p.health = .002;
    w.step(1); expect(p.alive).toBe(false); expect(p.diedAt).toBeGreaterThan(0); expect(isCommunityState(c)).toBe(true);
    const samples = c.motion!.tracks[0]!.samples;
    expect(humanMotionAt(samples, p.diedAt! - .01).alive).toBe(true);
    expect(humanMotionAt(samples, p.diedAt!).alive).toBe(false);
    expect(humanMotionAt(samples, p.diedAt!).action).toBeNull();
    expect(humanMotionAt(samples, 3601).position).toEqual(p.position);
  });
  it('cuts bulk steps inside actual segments and bounds the retained last-hour recording', () => {
    const w = world(); stepCommunity(w.community!, w.patches, w.waterBudget, 0, 3700, w.log, w.microEcology);
    const c = w.community!; expect(isCommunityState(c)).toBe(true);
    expect(c.motion).toMatchObject({ startWorldTime: 100, endWorldTime: 3700 });
    for (const t of c.motion!.tracks) { expect(t.samples[0]!.seconds).toBe(0); expect(t.samples.at(-1)!.seconds).toBe(3600); expect(t.samples.length).toBeLessThanOrEqual(MAX_HUMAN_MOTION_SAMPLES); }
  });
  it('survives JSON restart, accepts older checkpoints without recordings and never uses a recording to change future decisions', () => {
    const w = world(); w.step(1); const saved = JSON.parse(JSON.stringify(takeSnapshot(w)));
    const restored = restoreSnapshot(saved, options), legacy = structuredClone(saved); delete legacy.community.motion;
    const without = restoreSnapshot(legacy, options);
    expect(restored.community!.motion).toEqual(saved.community.motion);
    w.step(1); restored.step(1); without.step(1);
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(w)); expect(takeSnapshot(without)).toEqual(takeSnapshot(w));
  });
  it('rejects mismatched people/endpoints, invalid time order, unrecorded teleports and changing positions during work', () => {
    const w = world(); w.step(1); const original = takeSnapshot(w);
    const bad = (change: (s: typeof original) => void) => { const s = structuredClone(original); change(s); expect(() => restoreSnapshot(s, options)).toThrow('invalid community checkpoint'); };
    bad(s => { s.community!.motion!.tracks[0]!.personId = 'not-a-resident'; });
    bad(s => { s.community!.motion!.endWorldTime++; });
    bad(s => { s.community!.motion!.tracks[0]!.samples.at(-1)!.position.x++; });
    bad(s => { s.community!.motion!.tracks[0]!.samples[1]!.seconds = 0; });
    bad(s => { s.community!.motion!.tracks[0]!.samples[1]!.position.x += 1000; });
    bad(s => { const samples = s.community!.motion!.tracks[0]!.samples; const i = samples.findIndex((a, i) => samples[i + 1] && a.position.x !== samples[i + 1]!.position.x); samples[i]!.phase = 'work'; });
  });
});
