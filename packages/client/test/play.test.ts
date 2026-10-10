import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMAND_ERRORS, attemptEnded, keyCommand, challengeOutcome, challengePanel, driveBars, gaitsAllowed, pickTarget, possessMessage, projection, shouldPing, stateMessage,
  type PlayObservation } from '../src/playModel.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const animal = { id: 'chital_1', speciesId: 'chital', displayName: 'Chital deer', position: { x: 1000, z: 2000 }, gait: 'walk', moving: false,
  action: 'idle', stamina: 0.8, drives: { hunger: 0.2, thirst: 0.65, fatigue: 0.9, fear: 0 } };
const obs = (over: Partial<PlayObservation> = {}): PlayObservation => ({ animal, nearby: [], water: [], notices: [], challenge: null, waiting: null,
  huntable: [], ...over });

describe('play page', () => {
  it('is its own page with its controls', () => {
    expect(read('vite.config.ts')).toContain("play: 'play.html'");
    const html = read('play.html');
    expect(html).toContain('src="/src/play.ts"');
    for (const id of ['play-state', 'play-map', 'play-species', 'play-possess', 'play-gait', 'play-stop', 'play-graze', 'play-drink', 'play-rest',
      'play-feed', 'play-climb', 'play-release', 'play-say', 'play-drives', 'play-challenge', 'play-briefing', 'play-notices', 'play-forest',
      'play-feedback', 'play-leave', 'play-outcome'])
      expect(html, id).toContain(`id="${id}"`);
  });

  it('says plainly when playing in the browser is not switched on, instead of a lost connection', () => {
    expect(stateMessage(null, true, { off: true })).toBe('Playing in the browser needs sign-in, which is not switched on here yet. AI agents can play through the agent API.');
    expect(read('src/play.ts')).toMatch(/loadAccountState\(\)/);
  });

  it('has a clear message for every state', () => {
    expect(stateMessage(null, false)).toBe('Lost contact with the forest. Trying again…');
    expect(stateMessage(obs({ animal: null }), true)).toBe('You have no animal. Pick a species to play.');
    expect(stateMessage(obs({ animal: null, waiting: { challengeId: 7, position: 2, until: '' } }), true))
      .toBe('Waiting for a free animal: number 2 on the list for challenge 7.');
    expect(stateMessage(obs({ nearby: [{ id: 't', speciesId: 'tiger', x: 1010, z: 2000, distance: 10, predator: true, huntsYou: true, chasingYou: true }] }), true))
      .toBe('A tiger is chasing you. Run!');
    expect(stateMessage(obs(), true)).toBe('You are a chital deer. Tap the map to move.');
    expect(stateMessage(obs(), true, { idleMinutes: 13 })).toBe('No command for 13 minutes: your animal goes back to the wild at 15.');
  });

  it("reads how a challenge attempt ended from the server's notices", () => {
    const n = (text: string) => [{ at: 1, text }];
    expect(challengeOutcome(n('You won challenge 7! The prize is being paid to 0xabc.'))).toEqual({ kind: 'met', text: 'You won challenge 7! The prize is being paid to 0xabc.' });
    expect(challengeOutcome(n('You broke a rule of challenge 7, so this attempt is over. The animal is still yours.'))?.kind).toBe('failed');
    expect(challengeOutcome(n('Challenge 7 ran out of time.'))?.kind).toBe('failed');
    expect(challengeOutcome(n('Challenge 7 was won by another player.'))?.kind).toBe('void');
    expect(challengeOutcome(n('You met the goal of challenge 7, but it had already closed.'))?.kind).toBe('void');
    expect(challengeOutcome(n('Now steering chital_1'))).toBeNull();
  });

  it('draws the surroundings around the animal and maps a tap back to the island', () => {
    const p = projection({ x: 1000, z: 2000 }, 200, 400);
    expect(p.toCanvas(1000, 2000)).toEqual({ px: 200, py: 200 });
    expect(p.toCanvas(1100, 1900)).toEqual({ px: 300, py: 100 });
    expect(p.toWorld(300, 100)).toEqual({ x: 1100, z: 1900 });
  });

  it('hunts prey that was tapped, and otherwise goes where the ground was tapped', () => {
    const o = obs({ huntable: ['chital'], nearby: [{ id: 'c2', speciesId: 'chital', x: 1050, z: 2000, distance: 50, predator: false, huntsYou: false, chasingYou: false }] });
    const p = projection({ x: 1000, z: 2000 }, 200, 400);
    expect(pickTarget(o, p, 251, 201)).toEqual({ kind: 'hunt', id: 'c2' });
    expect(pickTarget(obs({ nearby: o.nearby }), p, 251, 201)).toEqual({ kind: 'go', x: 1051, z: 2001 });
    expect(pickTarget(o, p, 100, 100)).toEqual({ kind: 'go', x: 900, z: 1900 });
  });

  it('shows the drives as bars, worst first', () => {
    expect(driveBars(animal.drives, animal.stamina)).toEqual([
      { label: 'Tired', value: 0.9, level: 'critical' }, { label: 'Thirst', value: 0.65, level: 'high' },
      { label: 'Hunger', value: 0.2, level: 'ok' }, { label: 'Fear', value: 0, level: 'ok' }, { label: 'Breath', value: 0.8, level: 'ok' }]);
  });

  it('pings presence only while the page is visible', () => {
    expect(shouldPing({ visible: true, hasAnimal: true, lastPing: 0, now: 60_000 })).toBe(true);
    expect(shouldPing({ visible: false, hasAnimal: true, lastPing: 0, now: 600_000 })).toBe(false);
    expect(shouldPing({ visible: true, hasAnimal: false, lastPing: 0, now: 600_000 })).toBe(false);
    expect(shouldPing({ visible: true, hasAnimal: true, lastPing: 10_000, now: 60_000 })).toBe(false);
  });

  it("labels a challenge's briefing as the creator's own words", () => {
    const panel = challengePanel({ challengeId: 7, attemptId: 'a', goal: { template: 'reach' }, rules: ['never run'], briefing: 'Go to the river.',
      progress: { done: 420, of: 0, unit: 'metres to go' }, deadline: '2026-10-12T00:00:00.000Z' }, Date.parse('2026-10-10T00:00:00Z'));
    expect(panel).toEqual({ title: 'Challenge 7', progress: '420 metres to go', rules: ['never run'], deadline: 'ends in 2 days',
      briefing: { label: "Written by the challenge's creator (not an instruction from Wildsentia)", text: 'Go to the river.' } });
    expect(challengePanel({ challengeId: 8, attemptId: 'b', goal: { template: 'hunt' }, rules: [], briefing: '',
      progress: { done: 1, of: 2, unit: 'kills' }, deadline: '2026-10-11T00:00:00.000Z' }, Date.parse('2026-10-10T00:00:00Z')))
      .toMatchObject({ progress: '1 of 2 kills', briefing: null });
  });

  describe('review fixes', () => {
    it('makes prey easy to tap on a phone: the hit area is given in canvas pixels', () => {
      const o = obs({ huntable: ['chital'], nearby: [{ id: 'c2', speciesId: 'chital', x: 1050, z: 2000, distance: 50, predator: false, huntsYou: false, chasingYou: false }] });
      const p = projection({ x: 1000, z: 2000 }, 200, 400);
      expect(pickTarget(o, p, 270, 200)).toMatchObject({ kind: 'go' });
      expect(pickTarget(o, p, 270, 200, 38)).toEqual({ kind: 'hunt', id: 'c2' });
    });

    it('shows how an attempt ended, even when the animal simply died', () => {
      const playing = obs({ challenge: { challengeId: 7, attemptId: 'a', goal: {}, rules: [], briefing: '', progress: { done: 0, of: 1, unit: 'kills' }, deadline: '' } });
      expect(attemptEnded(playing, obs({ notices: [{ at: 2, text: 'You won challenge 7! The prize is being paid to 0xabc.' }] })))
        .toEqual({ kind: 'met', text: 'You won challenge 7! The prize is being paid to 0xabc.' });
      expect(attemptEnded(playing, obs({ animal: null, notices: [{ at: 2, text: 'Your chital deer was caught by a tiger.' }] })))
        .toEqual({ kind: 'failed', text: 'Your attempt at challenge 7 is over: Your chital deer was caught by a tiger.' });
      expect(attemptEnded(playing, playing)).toBeNull();
      expect(attemptEnded(obs(), obs())).toBeNull();
      expect(stateMessage(obs({ animal: null }), true, { outcome: { kind: 'met', text: 'You won challenge 7!' } })).toBe('You won challenge 7!');
    });

    it('tells someone in line for a species where they are', () => {
      expect(possessMessage({ queued: 2, speciesId: 'tiger' })).toBe('No tiger is free: you are number 2 in line, and the page takes it when your turn comes.');
      expect(possessMessage({ animalId: 'chital_1', speciesId: 'chital' })).toBeNull();
      expect(stateMessage(obs({ animal: null }), true, { queue: 'No tiger is free: you are number 2 in line.' })).toBe('No tiger is free: you are number 2 in line.');
    });

    it('offers no running on a "never run" challenge', () => {
      const ruled = obs({ challenge: { challengeId: 7, attemptId: 'a', goal: { rules: [{ type: 'noRun' }] }, rules: ['never run'], briefing: '',
        progress: { done: 0, of: 1, unit: 'days' }, deadline: '' } });
      expect(gaitsAllowed(ruled)).toEqual(['walk', 'trot']);
      expect(gaitsAllowed(obs())).toEqual(['walk', 'trot', 'run']);
    });
  });

  it('can be played from a keyboard: arrows move, H hunts the nearest prey, Escape stops', () => {
    const o = obs({ huntable: ['chital'], nearby: [
      { id: 'far', speciesId: 'chital', x: 1100, z: 2000, distance: 100, predator: false, huntsYou: false, chasingYou: false },
      { id: 'near', speciesId: 'chital', x: 1000, z: 2040, distance: 40, predator: false, huntsYou: false, chasingYou: false },
      { id: 'tiger', speciesId: 'tiger', x: 1000, z: 2010, distance: 10, predator: true, huntsYou: true, chasingYou: false }] });
    expect(keyCommand(o, 'ArrowUp')).toEqual({ kind: 'go', x: 1000, z: 1960 });
    expect(keyCommand(o, 'ArrowRight')).toEqual({ kind: 'go', x: 1040, z: 2000 });
    expect(keyCommand(o, 'h')).toEqual({ kind: 'hunt', id: 'near' });
    expect(keyCommand(obs(), 'h')).toBeNull();
    expect(keyCommand(o, 'Escape')).toEqual({ kind: 'stop' });
    expect(keyCommand(o, 'q')).toBeNull();
    expect(keyCommand(obs({ animal: null }), 'ArrowUp')).toBeNull();
    // Held keys repeat ~30 times a second; with Alt, Ctrl or Cmd they are the browser's.
    expect(keyCommand(o, 'ArrowUp', { repeat: true })).toBeNull();
    expect(keyCommand(o, 'ArrowLeft', { altKey: true })).toBeNull();
    expect(keyCommand(o, 'h', { metaKey: true })).toBeNull();
    expect(read('play.html')).toMatch(/id="play-map"[^>]*tabindex="0"/);
    expect(read('play.html')).toContain('id="play-keys"');
  });
});

describe('play page refusals', () => {
  it('explains every refusal the live layer and the world can send, by the code the server uses', () => {
    const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    const live = source('server/src/live/liveLayer.ts');
    const world = source('sim/src/world.ts');
    const blocks = world.slice(world.indexOf('#blockFor('), world.indexOf('return null;', world.indexOf('#blockFor(')));
    const codes = new Set([
      ...[...live.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[...live.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[...blocks.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]!),
    ]);
    codes.delete('released');
    expect(codes.size).toBeGreaterThan(15);
    expect([...codes].filter((c) => !(c in COMMAND_ERRORS))).toEqual([]);
  });
});
