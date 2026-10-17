import { afterEach, describe, expect, it } from 'vitest';
import { CONGO_GRID, ISLAND_GRID, patchCentre, type MovementTrace } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { climbPose, clipForClimbPhase } from '../src/animation.js';
import { recordedClimbPhase, recordedFlightPhase as recordedFlightPhaseOf } from '../src/liveEncounters.js';
import { PositionTracker } from '../src/space.js';

afterEach(() => setWorldGrid(ISLAND_GRID));

// A mangabey crossing aloft from tree to tree is drawn walking along the branches, body level,
// not frozen in the air nor turned upright as on a trunk.
describe('a monkey crossing through the canopy', () => {
  it('walks along the branches with its body level', () => {
    expect(clipForClimbPhase('crossing', ['Idle', 'Walk', 'Run'])).toBe('Walk');
    expect(clipForClimbPhase('crossing', ['Idle'])).toBe('Idle');
    expect(climbPose('agile_mangabey', 'crossing', 0.6)).toEqual({ pitch: 0, back: 0, lift: 0 });
  });

  it('reads a recorded crossing as one, aloft between two trunks', () => {
    setWorldGrid(CONGO_GRID);
    const a = patchCentre(CONGO_GRID, 30 * 160 + 30), b = patchCentre(CONGO_GRID, 30 * 160 + 31);
    const trace: MovementTrace = { version: 1, actorId: 'agile_mangabey_0001', startWorldTime: 0, destinationPatchId: 30 * 160 + 31, goal: 'wander',
      samples: [{ seconds: 0, position: { ...a, heading: 0 }, altitudeM: 20 }, { seconds: 200, position: { x: (a.x + b.x) / 2, z: a.z, heading: 0 }, altitudeM: 20 },
        { seconds: 400, position: { ...b, heading: 0 }, altitudeM: 20 }], completed: true };
    expect(recordedClimbPhase(trace, 100)).toBe('crossing');
    expect(recordedClimbPhase(trace, 300)).toBe('crossing');
    expect(recordedClimbPhase(trace, 400)).toBeNull();
  });

  it('draws a checkpoint-to-checkpoint move between two trees as a crossing', () => {
    setWorldGrid(CONGO_GRID);
    const tracker = new PositionTracker();
    const a = patchCentre(CONGO_GRID, 30 * 160 + 30), b = patchCentre(CONGO_GRID, 30 * 160 + 31);
    tracker.update('m', 30 * 160 + 30, 0, { ...a, heading: 0 }, 20);
    tracker.update('m', 30 * 160 + 31, 1000, { ...b, heading: 0 }, 20);
    expect(tracker.verticalPhaseAt('m', 1500)).toBe('crossing');
    // On the ground the same move is a walk, not a crossing.
    const ground = new PositionTracker();
    ground.update('g', 30 * 160 + 30, 0, { ...a, heading: 0 });
    ground.update('g', 30 * 160 + 31, 1000, { ...b, heading: 0 });
    expect(ground.verticalPhaseAt('g', 1500)).toBeNull();
  });
});

describe('replaying a canopy crossing', () => {
  it('accepts a recorded crossing from tree to tree, and tells it as one', async () => {
    const { isRecordedClimb, climbMoment } = await import('../src/replay.js');
    const { treeAnchorGeometry } = await import('@vana/shared');
    setWorldGrid(CONGO_GRID);
    const from = 30 * 160 + 30, to = 30 * 160 + 31, a = treeAnchorGeometry(CONGO_GRID, from)!, b = treeAnchorGeometry(CONGO_GRID, to)!;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, heading: 0 };
    const crossing = () => ({ eventId: 'e1', outcome: 'success', direction: 'traverse', reason: 'canopy_travel', treeAnchorId: b.id,
      from, verticalDistanceM: 0,
      trace: { version: 1, actorId: 'agile_mangabey_0001', startWorldTime: 0, destinationPatchId: to, goal: 'wander', completed: true,
        samples: [{ seconds: 0, position: { x: a.x, z: a.z, heading: 0 }, altitudeM: 20 }, { seconds: 200, position: mid, altitudeM: 20 },
          { seconds: 400, position: { x: b.x, z: b.z, heading: 0 }, altitudeM: 20 }] } });
    expect(isRecordedClimb(crossing())).toBe(true);
    const grounded = crossing(); grounded.trace.samples[1]!.altitudeM = 0;
    expect(isRecordedClimb(grounded)).toBe(false);
    const astray = crossing(); astray.trace.samples[1]!.position = { ...mid, x: mid.x + 30 };
    expect(isRecordedClimb(astray)).toBe(false);
    const far = crossing(); far.from = from + 3;
    expect(isRecordedClimb(far)).toBe(false);
    const recorded = crossing() as never;
    expect(climbMoment(recorded, 100)).toBe('Recorded crossing through the canopy');
    expect(climbMoment(recorded, 400)).toBe('Recorded crossing through the canopy · success');
  });
});

describe('a bird on its perch', () => {
  it('is not drawn gliding while it sits still up a tree', () => {
    const p = { x: 10, z: 10, heading: 0 };
    const trace = { version: 1 as const, actorId: 'crowned_eagle_0001', startWorldTime: 0, destinationPatchId: 0, goal: 'rest' as const, completed: true,
      samples: [{ seconds: 0, position: p, altitudeM: 34 }, { seconds: 60, position: p, altitudeM: 34 }, { seconds: 120, position: { x: 40, z: 10, heading: 0 }, altitudeM: 34 }] };
    expect(recordedFlightPhaseOf(trace, 30)).toBeNull();
    expect(recordedFlightPhaseOf(trace, 90)).toBe('gliding');
  });
});
