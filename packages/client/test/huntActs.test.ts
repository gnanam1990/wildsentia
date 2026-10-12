import { describe, expect, it } from 'vitest';
import type { EncounterTrace, EncounterPhase } from '@vana/shared';
import { deathSeconds, FALL_S, HOLD_AFTER_S, huntMoment, POUNCE_S, STRUCK_S } from '../src/huntActs.js';

const p = (x: number) => ({ x, z: 0, heading: 0 });
function trace(phases: Array<[number, EncounterPhase, number, number]>): EncounterTrace {
  return { version: 1, predatorId: 'tiger_1', preyId: 'chital_1', startWorldTime: 0, patchId: 0, contactRadiusM: 1,
    samples: phases.map(([seconds, phase, predator, prey]) => ({ seconds, phase, predator: p(predator), prey: p(prey) })) };
}
// A chase to contact at 20 s, then a 40 s recorded hold until the chital dies at 60 s.
const held = trace([[0, 'stalk', 0, 30], [10, 'chase', 10, 30], [20, 'contact', 39.5, 40], [30, 'subdue', 40, 40.6], [60, 'subdue', 40, 40.8]]);
// The same hunt recorded before holds existed: dead at contact.
const legacy = trace([[0, 'stalk', 0, 30], [10, 'chase', 10, 30], [20, 'contact', 39.5, 40]]);
const replay = (seconds: number) => (recorded: number) => seconds - recorded; // a replay runs recorded time 1:1
const moment = (t: EncounterTrace, seconds: number, outcome = 'success') => huntMoment(t, outcome, seconds,
  { phase: 'chase', predatorMoving: true, preyMoving: true, finished: seconds >= t.samples.at(-1)!.seconds }, replay(seconds));

describe('huntMoment', () => {
  it('takes the death from the end of the recorded hold, or from contact for older hunts', () => {
    expect(deathSeconds(held, 'success')).toBe(60);
    expect(deathSeconds(legacy, 'success')).toBe(20);
    expect(deathSeconds(held, 'failure')).toBeNull();
  });
  it('springs the last moments before contact, facing its prey', () => {
    expect(moment(held, 15).predator.state).toBe('chasing');
    const pounce = moment(held, 20 - POUNCE_S / 2);
    expect(pounce.predator).toEqual({ state: 'pouncing', act: expect.closeTo(POUNCE_S / 2, 6) });
    expect(pounce.facePrey).toBe(true);
  });
  it('holds the prey through the recorded hold while it is struck, falls and struggles, weakening, then dies', () => {
    expect(moment(held, 20.2).prey.state).toBe('struck');
    expect(moment(held, 20 + STRUCK_S + 0.5).prey).toEqual({ state: 'falling', act: expect.closeTo(0.5, 6) });
    const early = moment(held, 25), late = moment(held, 58);
    expect(early.prey.state).toBe('struggling');
    expect(late.prey.state).toBe('struggling');
    expect(early.prey.weight!).toBeGreaterThan(late.prey.weight!);
    expect(late.prey.weight!).toBeGreaterThanOrEqual(0.2);
    for (const s of [20.2, 25, 45, 59]) expect(moment(held, s).predator.state).toBe('holding');
    expect(moment(held, 60.5).prey.state).toBe('dead');
    expect(moment(held, 60.5).predator.state).toBe('holding');
    expect(moment(held, 60 + HOLD_AFTER_S + 0.1).predator.state).toBe('feeding');
  });
  it('lets an older hunt\'s prey collapse from contact, where it was recorded dead', () => {
    expect(moment(legacy, 20.3).prey).toEqual({ state: 'falling', act: expect.closeTo(0.3, 6) });
    expect(moment(legacy, 20 + FALL_S + 0.1).prey.state).toBe('dead');
    expect(moment(legacy, 21).predator.state).toBe('holding');
    expect(moment(legacy, 20 + HOLD_AFTER_S + FALL_S + 0.1).predator.state).toBe('feeding');
  });
  it('never kills in a failed hunt: a prey touched but not held is only struck', () => {
    expect(moment(legacy, 20.2, 'failure').prey.state).toBe('struck');
    expect(moment(legacy, 25, 'failure').prey.state).toBe('fleeing');
    expect(moment(legacy, 25, 'failure').predator.state).toBe('chasing');
  });
  it('times each act in real seconds, whatever pace the recorded hour is played at', () => {
    // Live playback shows idle recorded time faster than real time; acts follow the real clock.
    const fast = huntMoment(held, 'success', 30, { phase: 'subdue', predatorMoving: false, preyMoving: false, finished: false },
      (recorded) => (30 - recorded) / 12);
    expect(fast.prey).toEqual({ state: 'falling', act: expect.closeTo(10 / 12 - STRUCK_S, 6) });
  });
  it('shows a prey that broke free fighting the grip on its feet, then running, and never dead', () => {
    // sim_0.36: contact, a recorded hold, then escape; the hunt is a failure.
    const brokeFree = trace([[0, 'stalk', 0, 30], [10, 'chase', 10, 30], [20, 'contact', 39.5, 40], [24, 'subdue', 39.8, 40.4],
      [28, 'subdue', 40, 40.7], [40, 'escape', 41, 60]]);
    for (const s of [21, 25, 27.5]) {
      const m = moment(brokeFree, s, 'failure');
      expect(m.predator.state).toBe('holding');
      expect(m.prey.state).toBe('struck');
      expect(m.facePrey).toBe(true);
    }
    expect(moment(brokeFree, 30, 'failure').prey.state).toBe('fleeing');
    expect(moment(brokeFree, 30, 'failure').predator.state).toBe('chasing');
    for (const s of [21, 27, 30, 45]) expect(moment(brokeFree, s, 'failure').prey.state).not.toBe('dead');
  });
});
