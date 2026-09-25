import { describe, expect, it } from 'vitest';
import { recapFor, recapLine } from '../src/narration/recap.js';
import type { WorldEvent } from '../src/types/event.js';

const ev = (partial: Partial<WorldEvent> & Pick<WorldEvent, 'id' | 'type' | 'actors'>): WorldEvent => ({
  worldTime: 1000, simVersion: 'sim_0.5.0', patchId: 1, conditions: {}, outcome: 'success',
  effects: {}, causalParents: [], confidence: 'authoritative', ...partial,
});

describe('recapLine', () => {
  it('records lost care without inventing the parent death or an adoption', () => {
    const loss = ev({ id: 'loss1', type: 'parent_lost', actors: ['dhole_child', 'dhole_mother'], outcome: 'interrupted' });
    expect(recapLine(loss, 'dhole_child')).toEqual({ eventId: 'loss1', worldTime: 1000,
      text: 'Lost parental care from dhole_mother' });
    expect(recapLine(loss, 'dhole_mother')).toBeNull();
    expect(recapLine({ ...loss, type: 'provisioned' }, 'dhole_child')).toBeNull();
  });
  it('does not turn an unfinished approach into a claimed escape', () => {
    const attempt = ev({ id: 'hunt_3', type: 'hunt', actors: ['tiger_01', 'sambar_01'],
      outcome: 'failure', conditions: { stage: 'approaching' } });
    expect(recapLine(attempt, 'tiger_01')?.text).toContain('unresolved');
    expect(recapLine(attempt, 'sambar_01')).toBeNull();
    expect(recapLine({ ...attempt, conditions: { stage: 'chase_abandoned' } }, 'tiger_01')?.text).toContain('Abandoned');
  });
  it('distinguishes a recorded tree approach from actual ascent and descent', () => {
    const tree = ev({ id: 'tree_1', type: 'tree_climbed', actors: ['langur_1'],
      conditions: { direction: 'ascend' }, outcome: 'interrupted', effects: { verticalDistanceM: 0 } });
    expect(recapLine(tree, 'langur_1')?.text).toBe('Approached a tree; no ascent recorded');
    expect(recapLine(tree, 'langur_2')).toBeNull();
    expect(recapLine({ ...tree, effects: { verticalDistanceM: 3 } }, 'langur_1')?.text).toBe('Partly climbed a tree');
    expect(recapLine({ ...tree, conditions: { direction: 'descend' }, outcome: 'success',
      effects: { verticalDistanceM: 6 } }, 'langur_1')?.text).toBe('Descended from a tree');
  });
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

  it('retains only authoritative illness milestones for the affected animal', () => {
    const milestones = [
      ['disease_contracted', 'Contracted a modelled illness after eating carrion'],
      ['disease_symptomatic', 'Showed signs of illness'],
      ['disease_recovered', 'Recovered from an illness'],
      ['disease_fatal', 'Illness became fatal'],
    ] as const;
    for (const [type, text] of milestones) {
      const event = ev({ id: `illness_${type}`, type, actors: ['vulture_01'],
        conditions: { kind: 'carrion_infection', sourceMealEventId: 'meal_1' },
        causalParents: ['meal_1'] });
      expect(recapLine(event, 'vulture_01')).toEqual({ eventId: event.id, worldTime: 1000, text });
      expect(recapLine(event, 'vulture_02')).toBeNull();
    }
    expect(recapLine(ev({ id: 'meal_1', type: 'scavenged', actors: ['vulture_01'] }), 'vulture_01')).toBeNull();
  });
  it('tells only the wounded animal about the authoritative wound lifecycle', () => {
    const milestones = [
      ['wounded', 'Sustained a modelled wound after contact in a failed hunt'],
      ['wound_infected', 'A modelled wound became infected'],
      ['wound_healed', 'A modelled wound healed'],
      ['wound_infection_fatal', 'A modelled wound infection became fatal'],
    ] as const;
    for (const [type, text] of milestones) {
      const event = ev({ id: `wound_${type}`, type, actors: ['chital_01'],
        conditions: { kind: 'contact_injury', sourceHuntEventId: 'hunt_1' },
        causalParents: ['hunt_1'] });
      expect(recapLine(event, 'chital_01')).toEqual({ eventId: event.id, worldTime: 1000, text });
      expect(recapLine(event, 'chital_02')).toBeNull();
    }
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
