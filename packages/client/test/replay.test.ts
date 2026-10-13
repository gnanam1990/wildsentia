import { describe, expect, it } from 'vitest';
import { climbMoment, isRecordedClimb, momentsBetween, pointAt, replayDurationMs, trackPrecision, type LifeTrackPoint } from '../src/replay.js';
import { treeAnchorGeometry } from '@vana/shared';
import { patchCentre, subPatchOffset } from '../src/space.js';
import { ISLAND_GRID } from '@vana/shared';

const drives = { hunger: 0.2, thirst: 0.1, fatigue: 0.3, fear: 0 };
const track: LifeTrackPoint[] = [
  { worldTime: 0, patchId: 0, state: 'grazing', goal: 'find_food', drives },
  { worldTime: 100, patchId: 1, state: 'travelling', goal: 'find_water', drives: { ...drives, thirst: 0.9 } },
  { worldTime: 200, patchId: 21, state: 'drinking', goal: 'find_water', drives },
];

describe('replayDurationMs', () => {
  it('plays five years in two minutes, and short lives no faster than twenty seconds', () => {
    expect(replayDurationMs(5 * 365 * 86_400)).toBe(120_000);
    expect(replayDurationMs(86_400)).toBe(20_000);
    expect(replayDurationMs(20 * 365 * 86_400)).toBe(120_000);
  });
});

describe('pointAt', () => {
  it('labels precise, mixed and legacy records without inventing past precision', () => {
    const precise = { ...track[0]!, position: { x: 2, z: 4, heading: 1 } };
    expect(trackPrecision([precise])).toContain('Server-recorded');
    expect(trackPrecision([precise, track[1]!])).toContain('Mixed record');
    expect(trackPrecision(track)).toContain('Legacy patch-only');
    expect(trackPrecision([{ ...precise, position: { x: 999, z: 0, heading: 0 } }])).toContain('Legacy');
  });
  it('replays recorded within-patch movement and heading without client offsets', () => {
    const precise: LifeTrackPoint[] = [
      { ...track[0]!, position: { x: 2, z: 4, heading: 1 } },
      { ...track[1]!, patchId: 0, position: { x: 12, z: 14, heading: 2 } },
    ];
    expect(pointAt(precise, 'a', 50)).toMatchObject({ x: 7, z: 9, moving: true });
    expect(pointAt(precise, 'a', 100)).toMatchObject({ x: 12, z: 14, heading: 2, moving: false });
  });
  it('interpolates only recorded height pairs and never invents an unknown historical climb', () => {
    const exact: LifeTrackPoint[] = [
      { ...track[0]!, position: { x: 5, z: 5, heading: 1 }, altitudeM: 0 },
      { ...track[1]!, patchId: 0, position: { x: 5, z: 5, heading: 1 }, altitudeM: 6 },
    ];
    expect(pointAt(exact, 'langur', 50)).toMatchObject({ x: 5, z: 5, heading: 1,
      altitudeM: 3, moving: true });
    expect(pointAt(exact, 'langur', 100)).toMatchObject({ altitudeM: 6, moving: false });
    const unknown = [{ ...exact[0]!, altitudeM: undefined }, exact[1]!];
    expect(pointAt(unknown, 'langur', 50).altitudeM).toBeUndefined();
    expect(pointAt(unknown, 'langur', 50).moving).toBe(false);
  });
  it('eases between recorded places, and never puts the animal anywhere the record did not', () => {
    const offset = subPatchOffset(ISLAND_GRID, 'chital_0001');
    const start = pointAt(track, 'chital_0001', 0);
    expect(start.x).toBeCloseTo(patchCentre(ISLAND_GRID, 0).x + offset.x);
    const halfway = pointAt(track, 'chital_0001', 50);
    expect(halfway.x).toBeGreaterThan(start.x);
    expect(halfway.x).toBeLessThan(patchCentre(ISLAND_GRID, 1).x + offset.x);
    const end = pointAt(track, 'chital_0001', 999);
    expect(end.z).toBeCloseTo(patchCentre(ISLAND_GRID, 21).z + offset.z);
  });

  it('reports the state and drives recorded at the sample it last passed', () => {
    const p = pointAt(track, 'chital_0001', 150);
    expect(p.state).toBe('travelling');
    expect(p.drives.thirst).toBeCloseTo(0.9);
  });
});

describe('momentsBetween', () => {
  it('returns the moments the playhead crossed this frame, once each', () => {
    const moments = [{ worldTime: 50, text: 'a', eventId: 'e1' }, { worldTime: 120, text: 'b', eventId: 'e2' }];
    expect(momentsBetween(moments, 0, 60).map((m) => m.text)).toEqual(['a']);
    expect(momentsBetween(moments, 60, 130).map((m) => m.text)).toEqual(['b']);
    expect(momentsBetween(moments, 130, 200)).toEqual([]);
  });
});

describe('selected retained tree route', () => {
  const climb = () => {
    const anchor = treeAnchorGeometry(ISLAND_GRID, 210)!, ground = { x: anchor.x - 2, z: anchor.z, heading: 0 };
    return { eventId: 'tree_1', outcome: 'success' as const, direction: 'ascend' as const,
      reason: 'local_threat', treeAnchorId: anchor.id, verticalDistanceM: 6,
      trace: { version: 1 as const, actorId: 'langur_1', startWorldTime: 0, destinationPatchId: 210,
        goal: 'flee' as const, completed: true, samples: [
          { seconds: 0, position: ground },
          { seconds: 10, position: { x: anchor.x, z: anchor.z, heading: 0 }, altitudeM: 0 },
          { seconds: 34, position: { x: anchor.x, z: anchor.z, heading: 0 }, altitudeM: 6 },
        ] } };
  };
  it('uses exact saved route for labels, including approach before ascent', () => {
    const saved = climb(); expect(isRecordedClimb(saved)).toBe(true);
    expect(climbMoment(saved, 5)).toBe('Recorded approach to tree');
    expect(climbMoment(saved, 22)).toBe('Recorded tree ascent');
    expect(climbMoment(saved, 34)).toBe('Recorded tree ascent · success');
    const attempt = { ...saved, outcome: 'interrupted' as const, verticalDistanceM: 0,
      trace: { ...saved.trace, completed: false, samples: saved.trace.samples.slice(0, 2) } };
    expect(isRecordedClimb(attempt)).toBe(true);
    expect(climbMoment(attempt, 10)).toContain('no vertical climb occurred');
  });
  it('rejects false trunk, height, direction, duration and outcome assertions', () => {
    const saved = climb();
    for (const altered of [{ ...saved, treeAnchorId: 'wrong' }, { ...saved, verticalDistanceM: 0 },
      { ...saved, direction: 'descend' }, { ...saved, outcome: 'interrupted' },
      { ...saved, trace: { ...saved.trace, samples: saved.trace.samples.map((s, i) => i === 2
        ? { ...s, position: { ...s.position, x: s.position.x + 1 } } : s) } }])
      expect(isRecordedClimb(altered)).toBe(false);
  });
});
