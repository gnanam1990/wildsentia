import { describe, expect, it } from 'vitest';
import { encounterAt, isRecordedEncounter, ReplayClock, type RecordedEncounter } from '../src/encounterReplay.js';
import { replayClipTime } from '../src/animation.js';

const p = (x: number) => ({ x, z: 0, heading: Math.PI / 2 });
const encounter: RecordedEncounter = { eventId: 'hunt_1', outcome: 'success', predatorSpecies: 'tiger', preySpecies: 'sambar',
  trace: { version: 1, predatorId: 't1', preyId: 's1', patchId: 0, startWorldTime: 100, contactRadiusM: 1,
    samples: [
      { seconds: 0, phase: 'approach', predator: p(0), prey: p(10) },
      { seconds: 2, phase: 'stalk', predator: p(2), prey: p(10) },
      { seconds: 2, phase: 'chase', predator: p(2), prey: p(10) },
      { seconds: 4, phase: 'contact', predator: p(11), prey: p(12) },
    ] },
};

describe('paired recorded replay', () => {
  it('samples the terminal death pose and restores a live loop when seeking backwards', () => {
    expect(replayClipTime('dead', 2, 0)).toBe(2);
    expect(replayClipTime('fleeing', 2, 3)).toBe(1);
    expect(replayClipTime('resting', 0, 3)).toBe(0);
  });
  it('samples both actors on one timeline, preserving exact contact endpoints', () => {
    const before = structuredClone(encounter);
    expect(isRecordedEncounter(encounter)).toBe(true);
    expect(encounterAt(encounter.trace, 3)).toMatchObject({ phase: 'chase', predator: { x: 6.5 }, prey: { x: 11 }, finished: false });
    expect(encounterAt(encounter.trace, 4)).toMatchObject({ phase: 'contact', predator: { x: 11 }, prey: { x: 12 }, finished: true });
    expect(encounterAt(encounter.trace, 100)).toMatchObject({ predator: { x: 11, moving: false }, prey: { x: 12, moving: false } });
    expect(encounter).toEqual(before);
  });
  it('selects the later phase at an equal timestamp and clamps before the recording', () => {
    expect(encounterAt(encounter.trace, 2).phase).toBe('chase');
    expect(encounterAt(encounter.trace, -1).predator.x).toBe(0);
    expect(() => encounterAt(encounter.trace, NaN)).toThrow();
  });
  it('rejects missing species, unsupported traces and fabricated success away from contact', () => {
    expect(isRecordedEncounter({ ...encounter, preySpecies: undefined })).toBe(false);
    expect(isRecordedEncounter({ ...encounter, trace: { ...encounter.trace, version: 9 } })).toBe(false);
    for (const bad of [NaN, -1, Infinity]) {
      const copy = structuredClone(encounter); copy.trace.samples[1]!.seconds = bad;
      expect(isRecordedEncounter(copy)).toBe(false);
    }
    const copy = structuredClone(encounter); copy.trace.samples.at(-1)!.prey.x = 20;
    expect(isRecordedEncounter(copy)).toBe(false);
    copy.outcome = 'failure';
    expect(isRecordedEncounter(copy)).toBe(true);
  });
  it('rejects out-of-world positions and timestamp reversal without corrupting rendering', () => {
    const copy = structuredClone(encounter); copy.trace.samples[2]!.seconds = 1;
    expect(isRecordedEncounter(copy)).toBe(false);
    copy.trace.samples[2]!.seconds = 2; copy.trace.samples[0]!.predator.x = 9999;
    expect(isRecordedEncounter(copy)).toBe(false);
  });
});

describe('observer-only replay clock', () => {
  it('starts paused, supports play/pause, speed and explicit seeking, and holds the final frame', () => {
    const clock = new ReplayClock(1000);
    clock.tick(100); expect(clock.progress).toBe(0);
    clock.play(); clock.tick(100); expect(clock.progress).toBe(0.1);
    clock.speed = 4; clock.tick(100); expect(clock.progress).toBe(0.5);
    clock.seek(0.25); clock.tick(100); expect(clock.progress).toBe(0.25);
    clock.play(); clock.tick(1000); expect(clock.progress).toBe(1); expect(clock.paused).toBe(true);
    clock.play(); expect(clock.progress).toBe(0);
  });
  it('rejects invalid clock values and clamps valid out-of-range seeks', () => {
    expect(() => new ReplayClock(NaN)).toThrow();
    const clock = new ReplayClock(1000);
    expect(() => clock.tick(-1)).toThrow(); expect(() => clock.seek(NaN)).toThrow();
    clock.seek(-2); expect(clock.progress).toBe(0);
    clock.seek(2); expect(clock.progress).toBe(1);
  });
});
