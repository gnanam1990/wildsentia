import { describe, expect, it } from 'vitest';
import { treeAnchorGeometry, type LiveEncounterFrame } from '@vana/shared';
import { isLiveEncounterFrame, LiveEncounterPlayer, recordedClimbPhase, recordedFlightPhase,
  withRecordedVisualIdentity } from '../src/liveEncounters.js';
import type { AnimalState } from '../src/protocol.js';
import { PositionTracker } from '../src/space.js';

const p = (x: number) => ({ x, z: 0, heading: Math.PI / 2 });
function frame(): LiveEncounterFrame {
  return { id: 'stream:3600', startWorldTime: 0, endWorldTime: 3600, rate: 12, elapsedWorldSeconds: 0,
    encounters: [{ eventId: 'hunt_1', outcome: 'success', predatorSpecies: 'tiger', preySpecies: 'sambar',
      predator: { id: 't', speciesId: 'tiger', sizeRatio: 1, coatVariant: 0 },
      prey: { id: 's', speciesId: 'sambar', sizeRatio: 0.25, coatVariant: 1 },
      trace: { version: 1, predatorId: 't', preyId: 's', patchId: 0, startWorldTime: 0, contactRadiusM: 1,
        samples: [{ seconds: 0, phase: 'chase', predator: p(0), prey: p(10) },
          { seconds: 120, phase: 'contact', predator: p(19), prey: p(20) }] } }] };
}

describe('checkpointed live encounter playback', () => {
  it('keeps recorded movement and outcome while filling only missing visual identity', () => {
    const drives = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 };
    const recorded: AnimalState = { id: 'e', speciesId: 'elephant', patchId: 1, state: 'drinking',
      currentGoal: 'find_water', drives, sizeRatio: .8 };
    const current: AnimalState = { ...recorded, patchId: 2, state: 'resting', currentGoal: 'rest',
      sizeRatio: 1, sex: 'female', lifeStage: 'adult' };
    expect(withRecordedVisualIdentity(recorded, current)).toMatchObject({ patchId: 1,
      state: 'drinking', currentGoal: 'find_water', sizeRatio: .8, sex: 'female', lifeStage: 'adult' });
    expect(withRecordedVisualIdentity({ ...recorded, sex: 'male', lifeStage: 'juvenile' }, current))
      .toMatchObject({ sex: 'male', lifeStage: 'juvenile' });
    expect(withRecordedVisualIdentity(recorded, { ...current, speciesId: 'tiger' })).toBe(recorded);
  });
  it('accepts recorded sex/stage but rejects malformed visual identity', () => {
    const f = frame(); f.encounters[0]!.predator.sex = 'male';
    f.encounters[0]!.predator.lifeStage = 'adult';
    expect(isLiveEncounterFrame(f)).toBe(true);
    const badSex = structuredClone(f); (badSex.encounters[0]!.predator as { sex?: string }).sex = 'other';
    expect(isLiveEncounterFrame(badSex)).toBe(false);
    const badStage = structuredClone(f); (badStage.encounters[0]!.predator as { lifeStage?: string }).lifeStage = 'future';
    expect(isLiveEncounterFrame(badStage)).toBe(false);
  });
  it('uses only same-trunk saved altitude samples for langur/squirrel climb phases', () => {
    const anchor = treeAnchorGeometry(210)!;
    const position = { x: anchor.x, z: anchor.z, heading: 0 };
    const f = frame(); f.encounters = [];
    f.movements = [{ eventId: 'climb', actor: { id: 'l', speciesId: 'langur', sizeRatio: 1, coatVariant: 0 },
      trace: { version: 1, actorId: 'l', startWorldTime: 0, destinationPatchId: 210,
        goal: 'flee', completed: true,
        samples: [{ seconds: 0, position, altitudeM: 0 }, { seconds: 24, position, altitudeM: 6 }] } }];
    const trace = f.movements[0]!.trace;
    expect(isLiveEncounterFrame(f)).toBe(true);
    expect(recordedClimbPhase(trace, 12)).toBe('ascending');
    expect(recordedClimbPhase(trace, 24)).toBeNull();
    const player = new LiveEncounterPlayer(); expect(player.apply(f, 0)).toBe(true);
    // A 6 m climb is shown at 0.8 m/s: 7.5 real seconds, half-way up at 3.75 s.
    expect(player.poses(3750).get('l')).toMatchObject({ climbVisualPhase: 'ascending',
      position: { x: anchor.x, z: anchor.z, moving: true }, animal: { state: 'fleeing' } });
    expect(player.poses(3750).get('l')!.position.altitudeM).toBeCloseTo(3);
    expect(player.poses(8000).get('l')?.climbVisualPhase).toBeUndefined();
    const descending = structuredClone(trace);
    descending.samples = [{ seconds: 0, position, altitudeM: 6 }, { seconds: 24, position, altitudeM: 0 }];
    expect(recordedClimbPhase(descending, 12)).toBe('descending');
    const missing = structuredClone(trace); delete missing.samples[1]!.altitudeM;
    expect(recordedClimbPhase(missing, 12)).toBeNull();
    const offTrunk = structuredClone(trace); offTrunk.samples[1]!.position.x += .01;
    expect(recordedClimbPhase(offTrunk, 12)).toBeNull();
    const nonArboreal = structuredClone(f); nonArboreal.movements![0]!.actor.speciesId = 'sambar';
    const other = new LiveEncounterPlayer(); expect(other.apply(nonArboreal, 0)).toBe(true);
    expect(other.poses(1000).get('l')?.climbVisualPhase).toBeUndefined();
  });
  it('labels only saved vulture altitude segments as ascent, glide and descent', () => {
    const f = frame(); f.encounters = [];
    f.movements = [{ eventId: 'flight', actor: { id: 'v', speciesId: 'vulture', sizeRatio: 1, coatVariant: 0 },
      trace: { version: 1, actorId: 'v', startWorldTime: 0, destinationPatchId: 0, goal: 'find_food', completed: true,
        samples: [{ seconds: 0, position: p(0), altitudeM: 0 },
          { seconds: 10, position: p(2), altitudeM: 60 },
          { seconds: 40, position: p(10), altitudeM: 60 },
          { seconds: 50, position: p(12), altitudeM: 0 }] } }];
    const trace = f.movements[0]!.trace;
    expect(isLiveEncounterFrame(f)).toBe(true);
    expect(recordedFlightPhase(trace, 5)).toBe('ascending');
    expect(recordedFlightPhase(trace, 20)).toBe('gliding');
    expect(recordedFlightPhase(trace, 45)).toBe('descending');
    expect(recordedFlightPhase(trace, 50)).toBeNull();
    const player = new LiveEncounterPlayer(); expect(player.apply(f, 0)).toBe(true);
    expect(player.poses(500).get('v')).toMatchObject({ flightVisualPhase: 'ascending', position: { altitudeM: 36 } });
    expect(player.poses(2000).get('v')?.flightVisualPhase).toBe('gliding');
    expect(player.poses(3750).get('v')?.flightVisualPhase).toBe('descending');
    expect(player.poses(5000).get('v')?.flightVisualPhase).toBeUndefined();
    expect(player.poses(500, true).size).toBe(0);
    const missing = structuredClone(trace); delete missing.samples[1]!.altitudeM;
    expect(recordedFlightPhase(missing, 5)).toBeNull();
    expect(recordedFlightPhase(missing, 20)).toBeNull();
    expect(recordedFlightPhase({ ...trace, completed: false }, 60)).toBeNull();
    const partial = structuredClone(trace); partial.completed = false; partial.samples.pop();
    expect(recordedFlightPhase(partial, 60)).toBeNull();
    const nonVulture = structuredClone(f); nonVulture.movements![0]!.actor.speciesId = 'sambar';
    const other = new LiveEncounterPlayer(); expect(other.apply(nonVulture, 0)).toBe(true);
    expect(other.poses(500).get('v')?.flightVisualPhase).toBeUndefined();
  });
  function drinkingFrame(): LiveEncounterFrame {
    return { ...frame(), encounters: [], movements: [{ eventId: 'approach',
      actor: { id: 's', speciesId: 'sambar', sizeRatio: 1, coatVariant: 0 },
      trace: { version: 1, actorId: 's', startWorldTime: 0, destinationPatchId: 0, goal: 'find_water', completed: true,
        samples: [{ seconds: 0, position: p(10) }, { seconds: 120, position: p(1.5) }] },
      activity: { type: 'drinking', eventId: 'drink', startSeconds: 120, endSeconds: 600,
        position: { ...p(1.5), heading: -Math.PI / 2 }, litres: 2 } }] };
  }
  it('shows drinking only after arrival, inside the recorded half-open window', () => {
    const f = drinkingFrame(), player = new LiveEncounterPlayer();
    expect(player.apply(f, 0)).toBe(true);
    expect(player.poses(5000).get('s')).toMatchObject({ eventId: 'approach',
      position: { x: 5.75, moving: true }, animal: { state: 'travelling' } });
    expect(player.poses(10_000).get('s')).toMatchObject({ eventId: 'drink',
      position: { x: 1.5, moving: false, heading: -Math.PI / 2 }, animal: { state: 'drinking' } });
    const late = new LiveEncounterPlayer(); late.apply({ ...f, elapsedWorldSeconds: 120 }, 99_000);
    expect(late.poses(99_000)).toEqual(player.poses(10_000));
    player.apply(f, 10_000); expect(player.poses(10_000).get('s')!.animal.state).toBe('drinking');
    expect(player.poses(50_000).get('s')).toMatchObject({ animal: { state: 'resting' },
      phase: 'recorded drinking completed', position: { moving: false } });
    expect(player.poses(20_000, true).size).toBe(0);
    expect(player.poses(300_000).size).toBe(0);
  });
  it('plays stationary drinking from an observed point without a fabricated approach', () => {
    const f = drinkingFrame(), m = f.movements![0]!;
    m.stationary = true; m.eventId = 'drink'; m.activity!.startSeconds = 0;
    m.trace.samples = [{ seconds: 0, position: p(1.5) }];
    const player = new LiveEncounterPlayer(); expect(player.apply(f, 0)).toBe(true);
    expect(player.poses(0).get('s')).toMatchObject({ position: { x: 1.5, moving: false }, animal: { state: 'drinking' } });
    expect(player.poses(50_000).get('s')!.animal.state).toBe('resting');
  });
  it('rejects mismatched water windows, ownership and stationary metadata', () => {
    const mutations: Array<(f: LiveEncounterFrame) => void> = [
      f => { f.movements![0]!.activity!.startSeconds = 119; },
      f => { f.movements![0]!.activity!.endSeconds = 120; },
      f => { f.movements![0]!.activity!.endSeconds = 3601; },
      f => { f.movements![0]!.activity!.position.x = 3; },
      f => { f.movements![0]!.activity!.litres = NaN; },
      f => { f.movements![0]!.activity!.eventId = 'approach'; },
      f => { f.movements![0]!.trace.completed = false; },
      f => { f.movements![0]!.trace.goal = 'wander'; },
      f => { f.movements![0]!.stationary = true; },
      f => { f.movements![0]!.stationary = true; delete f.movements![0]!.activity; },
      f => { const other = structuredClone(f.movements![0]!); other.eventId = 'other';
        other.actor.id = 'x'; other.trace.actorId = 'x'; f.movements!.push(other); },
    ];
    for (const mutate of mutations) { const f = drinkingFrame(); mutate(f); expect(isLiveEncounterFrame(f)).toBe(false); }
    const f = drinkingFrame();
    expect(isLiveEncounterFrame({ ...f, movements: [{ ...f.movements![0], stationary: false }] })).toBe(false);
  });
  it('plays ordinary routes on the shared clock, stops at endpoints and respects reduced motion', () => {
    const f = frame(); f.encounters = [];
    f.movements = [{ eventId: 'move_s', actor: { id: 's', speciesId: 'sambar', sizeRatio: 0.25, coatVariant: 1 },
      trace: { version: 1, actorId: 's', startWorldTime: 0, destinationPatchId: 0, goal: 'find_water', completed: true,
        samples: [{ seconds: 0, position: p(0) }, { seconds: 60, position: p(60) },
          { seconds: 120, position: { x: 60, z: 60, heading: 0 } }] } }];
    const a = new LiveEncounterPlayer(); expect(a.apply(f, 0)).toBe(true);
    // Each 60 m leg is shown at a sambar's walking pace, 1.4 m/s, not 12x its recorded speed.
    const leg = 60 / 1.4 * 1000;
    const mid = a.poses(leg * 1.5).get('s')!;
    expect(mid).toMatchObject({ kind: 'movement', position: { x: 60, moving: true },
      animal: { state: 'travelling', sizeRatio: 0.25 } });
    expect(mid.position.z).toBeCloseTo(30);
    expect(a.poses(leg * 1.5 + 1000).get('s')!.position.z - mid.position.z).toBeCloseTo(1.4);
    expect(a.poses(leg * 1.5, true).size).toBe(0);
    a.apply(f, leg * 1.5); // No rewind on duplicate.
    expect(a.poses(leg * 1.5).get('s')!.position.z).toBeCloseTo(30);
    const b = new LiveEncounterPlayer(); b.apply({ ...f, elapsedWorldSeconds: leg * 1.5 / 1000 * 12 }, 20_000);
    expect(b.poses(20_000).get('s')!.position.z).toBeCloseTo(30);
    expect(a.poses(leg * 2 + 1000).get('s')).toMatchObject({ position: { x: 60, z: 60, moving: false }, animal: { state: 'resting' } });
    expect(a.poses(300_000).size).toBe(0);
    const conflict = frame(); conflict.movements = f.movements;
    expect(isLiveEncounterFrame(conflict)).toBe(false);
    f.movements.push(structuredClone(f.movements[0]!)); expect(isLiveEncounterFrame(f)).toBe(false);
  });
  it('uses the same playhead for both actors and does not reveal death before contact', () => {
    const player = new LiveEncounterPlayer(); expect(player.apply(frame(), 1000)).toBe(true);
    const poses = player.poses(6000);
    expect(poses.get('t')!.position.x).toBe(9.5); expect(poses.get('s')!.position.x).toBe(15);
    expect(poses.get('s')!.animal).toMatchObject({ state: 'fleeing', sizeRatio: 0.25 });
    const end = player.poses(11_000);
    expect(end.get('s')!.animal.state).toBe('dead');
    expect(end.get('t')!.position.x).toBe(19);
    expect(player.poses(50_000).get('s')!.position.x).toBe(20);
  });
  it('does not restart on duplicate or late broadcasts and joins at the server playhead', () => {
    const a = new LiveEncounterPlayer(), b = new LiveEncounterPlayer();
    a.apply(frame(), 0);
    a.apply({ ...frame(), elapsedWorldSeconds: 20 }, 5000); // late packet: local is already 60s
    expect(a.poses(5000).get('t')!.position.x).toBe(9.5);
    b.apply({ ...frame(), elapsedWorldSeconds: 60 }, 9000); // a different client monotonic origin
    expect(b.poses(9000)).toEqual(a.poses(5000));
  });
  it('bounds disconnected extrapolation and clears on server loss/restart', () => {
    const player = new LiveEncounterPlayer(); player.apply(frame(), 0);
    expect(player.poses(300_000).size).toBe(0);
    player.apply({ ...frame(), id: 'new-stream:3600' }, 300_000);
    expect(player.poses(300_000).get('t')!.position.x).toBe(0);
    player.clear(); expect(player.poses(300_001).size).toBe(0);
    player.apply(frame(), 0); player.apply(null, 100); expect(player.poses(200).size).toBe(0);
  });
  it('rejects conflicting ownership, invalid metadata, invalid clocks and out-of-window traces', () => {
    expect(isLiveEncounterFrame(frame())).toBe(true);
    for (const rate of [0, -1, Infinity, NaN]) expect(isLiveEncounterFrame({ ...frame(), rate })).toBe(false);
    const duplicate = frame(); duplicate.encounters.push({ ...duplicate.encounters[0]!, eventId: 'hunt_2' });
    expect(isLiveEncounterFrame(duplicate)).toBe(false);
    const bad = frame(); bad.encounters[0]!.prey.id = 'other'; expect(isLiveEncounterFrame(bad)).toBe(false);
    const late = frame(); late.encounters[0]!.trace.samples[1]!.seconds = 3601;
    expect(isLiveEncounterFrame(late)).toBe(false);
    const player = new LiveEncounterPlayer(); player.apply(frame(), 0);
    expect(player.apply(bad, 5000)).toBe(false); expect(player.poses(5000).get('t')!.position.x).toBe(9.5);
  });
  it('rejects malformed route envelopes and enforces actor/sample payload budgets', () => {
    const actor = { id: 'x', speciesId: 'sambar', sizeRatio: 1, coatVariant: 0 };
    const movement = { eventId: 'm', actor, trace: { version: 1, actorId: 'x', startWorldTime: 0,
      destinationPatchId: 0, goal: 'wander', completed: true,
      samples: [{ seconds: 0, position: p(0) }, { seconds: 10, position: p(10) }] } };
    const base = { ...frame(), encounters: [], movements: [movement] };
    expect(isLiveEncounterFrame(base)).toBe(true);
    expect(isLiveEncounterFrame({ ...base, movements: [null] })).toBe(false);
    expect(isLiveEncounterFrame({ ...base, movements: [{ ...movement, actor: { ...actor, id: 'wrong' } }] })).toBe(false);
    expect(isLiveEncounterFrame({ ...base, movements: [{ ...movement, trace: { ...movement.trace, startWorldTime: 3600 } }] })).toBe(false);
    expect(isLiveEncounterFrame({ ...base, movements: Array(2049).fill(movement) })).toBe(false);
    const many = Array.from({ length: 17 }, (_, i) => ({ ...movement, eventId: `m${i}`, actor: { ...actor, id: `x${i}` },
      trace: { ...movement.trace, actorId: `x${i}`, samples: Array.from({ length: 2048 }, (_, seconds) => ({ seconds, position: p(0) })) } }));
    expect(isLiveEncounterFrame({ ...base, movements: many.slice(0, 16) })).toBe(true);
    expect(isLiveEncounterFrame({ ...base, movements: many })).toBe(false);
  });
  it('hands a recorded endpoint back to ordinary interpolation without jumping backwards', () => {
    const tracker = new PositionTracker(); tracker.update('t', 0, 0, p(0));
    tracker.placeRecorded('t', { ...p(19), moving: false }, 10_000);
    tracker.update('t', 0, 11_000, p(30));
    expect(tracker.positionAt('t', 11_000).x).toBe(19);
    expect(tracker.positionAt('t', 161_000).x).toBeCloseTo(24.5);
  });
});
