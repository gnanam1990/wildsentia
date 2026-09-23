import { describe, expect, it } from 'vitest';
import { recapFor, recapLine } from '../src/narration/recap.js';
import type { WorldEvent } from '../src/types/event.js';

const ev = (partial: Partial<WorldEvent> & Pick<WorldEvent, 'id' | 'type' | 'actors'>): WorldEvent => ({
  worldTime: 1000, simVersion: 'sim_0.5.0', patchId: 1, conditions: {}, outcome: 'success',
  effects: {}, causalParents: [], confidence: 'authoritative', ...partial,
});

describe('recapLine', () => {
  it('tells each side of a birth from its own point of view', () => {
    const born = ev({ id: 'born_1', type: 'born', actors: ['chital_0a', 'chital_01', 'chital_02'] });
    expect(recapLine(born, 'chital_0a')?.text).toBe('Was born');
    expect(recapLine(born, 'chital_01')?.text).toBe('Gave birth to chital_0a');
    expect(recapLine(born, 'chital_02')?.text).toBe('Fathered chital_0a');
  });

  it('names the cause of a death, and leaves the killer\'s side to the hunt', () => {
    const died = ev({ id: 'died_1', type: 'died', actors: ['sambar_01', 'tiger_01'], conditions: { cause: 'predation' } });
    expect(recapLine(died, 'sambar_01')?.text).toBe('Died — predation');
    expect(recapLine(died, 'tiger_01')).toBeNull();
  });

  it('tells a hunt from both ends', () => {
    const kill = ev({ id: 'hunt_1', type: 'hunt', actors: ['tiger_01', 'sambar_01'], outcome: 'success' });
    const miss = ev({ id: 'hunt_2', type: 'hunt', actors: ['tiger_01', 'chital_01'], outcome: 'failure', conditions: { stage: 'escaped' } });
    expect(recapLine(kill, 'tiger_01')?.text).toBe('Killed a sambar');
    expect(recapLine(miss, 'tiger_01')?.text).toBe('A hunt failed — the chital escaped');
    expect(recapLine(miss, 'chital_01')?.text).toBe('Escaped a tiger');
  });

  it('records a lesson for pupil and teacher', () => {
    const lesson = ev({ id: 'skill_1', type: 'skill_taught', actors: ['chital_0a', 'chital_01'], conditions: { skill: 'water_locations' } });
    expect(recapLine(lesson, 'chital_0a')?.text).toBe('Learned where the water is from chital_01');
    expect(recapLine(lesson, 'chital_01')?.text).toBe('Showed chital_0a where the water is');
  });

  it('skips the routine: a recap is what changed, not every mouthful', () => {
    for (const type of ['fed', 'drank', 'moved', 'rested'] as const) {
      expect(recapLine(ev({ id: `${type}_1`, type, actors: ['chital_01'] }), 'chital_01')).toBeNull();
    }
  });

  it('carries the event id, so every line can be checked against the record', () => {
    const line = recapLine(ev({ id: 'life_stage_9', type: 'life_stage', actors: ['hare_01'], conditions: { stage: 'adult' } }), 'hare_01');
    expect(line).toEqual({ eventId: 'life_stage_9', worldTime: 1000, text: 'Grew into an adult' });
  });
});

describe('recapFor', () => {
  it('orders lines in time and folds repeats together', () => {
    const lines = recapFor([
      ev({ id: 'f3', type: 'fled', actors: ['hare_01'], worldTime: 300 }),
      ev({ id: 'f1', type: 'fled', actors: ['hare_01'], worldTime: 100 }),
      ev({ id: 'f2', type: 'fled', actors: ['hare_01'], worldTime: 200 }),
      ev({ id: 'ls', type: 'life_stage', actors: ['hare_01'], worldTime: 400, conditions: { stage: 'adult' } }),
    ], 'hare_01');
    expect(lines.map((l) => l.text)).toEqual(['Ran from danger ×3', 'Grew into an adult']);
    expect(lines[0]!.eventId).toBe('f1');
  });
});
