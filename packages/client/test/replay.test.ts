import { describe, expect, it } from 'vitest';
import { momentsBetween, pointAt, replayDurationMs, type LifeTrackPoint } from '../src/replay.js';
import { patchCentre, subPatchOffset } from '../src/space.js';

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
  it('eases between recorded places, and never puts the animal anywhere the record did not', () => {
    const offset = subPatchOffset('chital_0001');
    const start = pointAt(track, 'chital_0001', 0);
    expect(start.x).toBeCloseTo(patchCentre(0).x + offset.x);
    const halfway = pointAt(track, 'chital_0001', 50);
    expect(halfway.x).toBeGreaterThan(start.x);
    expect(halfway.x).toBeLessThan(patchCentre(1).x + offset.x);
    const end = pointAt(track, 'chital_0001', 999);
    expect(end.z).toBeCloseTo(patchCentre(21).z + offset.z);
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
