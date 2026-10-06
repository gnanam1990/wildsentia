import { describe, expect, it } from 'vitest';
import type { MovementTrace } from '@vana/shared';
import { displaySecondAt, pace, paceEncounter, paceMovement, recordedSecondAt, walkingPace } from '../src/pacing.js';

const at = (x: number, z = 0) => ({ x, z, heading: 0 });
function route(speciesId: string, samples: MovementTrace['samples'], goal: MovementTrace['goal'] = 'find_food'): MovementTrace {
  return { version: 1, actorId: speciesId, startWorldTime: 0, destinationPatchId: 0, goal, completed: true, samples };
}
/** Metres per real second on screen over a displayed interval, at 12 world seconds per real second. */
function screenSpeed(trace: MovementTrace, displayFrom: number, displayTo: number, speciesId: string): number {
  const pacing = paceMovement(trace, speciesId, 12);
  const x = (d: number) => {
    const t = recordedSecondAt(pacing, d), s = trace.samples;
    for (let i = 1; i < s.length; i++) if (t <= s[i]!.seconds) {
      const a = s[i - 1]!, b = s[i]!, k = (t - a.seconds) / (b.seconds - a.seconds || 1);
      return a.position.x + (b.position.x - a.position.x) * Math.max(0, Math.min(1, k));
    }
    return s.at(-1)!.position.x;
  };
  return Math.abs(x(displayTo) - x(displayFrom)) / ((displayTo - displayFrom) / 12);
}

describe('presentation pacing of a recorded hour', () => {
  it('shows a walked route at walking pace instead of twelve times its recorded speed', () => {
    // 300 m walked at 1 m/s in five world minutes, then an idle hour.
    const trace = route('chital', [{ seconds: 600, position: at(0) }, { seconds: 900, position: at(300) }]);
    const pacing = paceMovement(trace, 'chital', 12);
    const start = pacing.display[pacing.trace.indexOf(600)]!, end = pacing.display[pacing.trace.indexOf(900)]!;
    expect(screenSpeed(trace, start, end, 'chital')).toBeCloseTo(walkingPace('chital'));
    // The walk now fills most of the hour, and still finishes inside it.
    expect(end - start).toBeCloseTo(300 / 1.4 * 12);
    expect(end).toBeLessThan(3600);
  });

  it('keeps the hour fixed and never runs backwards', () => {
    const trace = route('hare', [{ seconds: 5, position: at(0) }, { seconds: 50, position: at(40) },
      { seconds: 800, position: at(40) }, { seconds: 900, position: at(90) }, { seconds: 3000, position: at(95) }]);
    const pacing = paceMovement(trace, 'hare', 12);
    expect(recordedSecondAt(pacing, 0)).toBe(0);
    expect(recordedSecondAt(pacing, 3600)).toBe(3600);
    expect(recordedSecondAt(pacing, -5)).toBe(0);
    let last = -1;
    for (let d = 0; d <= 3600; d += 7) {
      const t = recordedSecondAt(pacing, d); expect(t).toBeGreaterThanOrEqual(last); last = t;
      expect(displaySecondAt(pacing, t)).toBeCloseTo(d, 6);
    }
  });

  it('plays an hour with more movement than fits proportionally faster, still inside the hour', () => {
    const trace = route('elephant', [{ seconds: 0, position: at(0) }, { seconds: 3600, position: at(5000) }]);
    const pacing = paceMovement(trace, 'elephant', 12);
    expect(pacing.display.at(-1)).toBe(3600);
    expect(recordedSecondAt(pacing, 1800)).toBeCloseTo(1800);
  });

  it('runs a fleeing animal, glides a vulture and climbs at a climbing pace', () => {
    const walk = route('chital', [{ seconds: 0, position: at(0) }, { seconds: 60, position: at(60) }]);
    const flee = route('chital', walk.samples, 'flee');
    const walkEnd = paceMovement(walk, 'chital', 12).display[1]!;
    const fleeEnd = paceMovement(flee, 'chital', 12).display[1]!;
    expect(walkEnd / fleeEnd).toBeCloseTo(3.5);
    const flight = route('vulture', [{ seconds: 0, position: at(0), altitudeM: 60 }, { seconds: 20, position: at(360), altitudeM: 60 }]);
    const flightEnd = paceMovement(flight, 'vulture', 12).display[1]!;
    expect(360 / (flightEnd / 12)).toBeCloseTo(12);
    const climb = route('langur', [{ seconds: 0, position: at(0), altitudeM: 0 }, { seconds: 10, position: at(0), altitudeM: 8 }]);
    expect(paceMovement(climb, 'langur', 12).display[1]! / 12).toBeCloseTo(10);
  });

  it('gives a predator and its prey one timeline, with the chase fast and the stalk slow', () => {
    const pacing = paceEncounter({ version: 1, predatorId: 't', preyId: 's', startWorldTime: 0, patchId: 0, contactRadiusM: 1,
      samples: [{ seconds: 100, phase: 'stalk', predator: at(0), prey: at(50) },
        { seconds: 160, phase: 'chase', predator: at(24), prey: at(50) },
        { seconds: 166, phase: 'contact', predator: at(90), prey: at(92) }] }, 12);
    const stalk = pacing.display[2]! - pacing.display[1]!, chase = pacing.display[3]! - pacing.display[2]!;
    expect(24 / (stalk / 12)).toBeCloseTo(1.2);
    expect(66 / (chase / 12)).toBeCloseTo(12);
  });

  it('plays a recorded hold in real time, not at the hour\'s pace', () => {
    const pacing = paceEncounter({ version: 1, predatorId: 't', preyId: 's', startWorldTime: 0, patchId: 0, contactRadiusM: 1,
      samples: [{ seconds: 100, phase: 'chase', predator: at(0), prey: at(20) },
        { seconds: 106, phase: 'contact', predator: at(59), prey: at(60) },
        { seconds: 146, phase: 'subdue', predator: at(60), prey: at(61) }] }, 12);
    const hold = pacing.display[3]! - pacing.display[2]!;
    expect(hold / 12).toBeCloseTo(40); // forty recorded seconds of struggle take forty real seconds
  });

  it('leaves an idle hour untouched', () => {
    const idle = pace([{ from: 0, to: 3600, minDisplay: null }]);
    expect(recordedSecondAt(idle, 1234)).toBeCloseTo(1234);
  });
});
