import { describe, expect, it } from 'vitest';
import { thoughtFor, type ThoughtInput } from '../src/narration/thought.js';

const base: ThoughtInput = {
  state: 'resting', currentGoal: 'rest', alternativeGoal: 'wander', goalScore: 0.4,
  drives: { hunger: 0.2, thirst: 0.2, fatigue: 0.3, fear: 0 }, dependent: false,
};

describe('thoughtFor', () => {
  it('says a thirsty animal is heading for water, and shows the drive behind it', () => {
    const t = thoughtFor({ ...base, currentGoal: 'find_water', state: 'travelling', drives: { ...base.drives, thirst: 0.81 } });
    expect(t.text).toBe('Thirsty — heading for water');
    expect(t.basis).toContain('goal find_water');
    expect(t.basis).toContain('thirst 81%');
  });

  it('describes what the animal is doing now, not only what it wants', () => {
    expect(thoughtFor({ ...base, currentGoal: 'find_water', state: 'drinking' }).text).toBe('Drinking');
    expect(thoughtFor({ ...base, currentGoal: 'find_food', state: 'grazing' }).text).toBe('Grazing');
    expect(thoughtFor({ ...base, currentGoal: 'hunt', state: 'stalking' }).text).toBe('Stalking — keeping low');
  });

  it('adds the runner-up when it pulls against the choice', () => {
    const t = thoughtFor({
      ...base, currentGoal: 'find_food', state: 'grazing', alternativeGoal: 'flee',
      drives: { ...base.drives, fear: 0.45 },
    });
    expect(t.text).toBe('Grazing, but uneasy — watching for danger');
  });

  it('says exhausted after running, from fatigue alone', () => {
    expect(thoughtFor({ ...base, currentGoal: 'rest', drives: { ...base.drives, fatigue: 0.9 } }).text)
      .toBe('Exhausted — resting');
  });

  it('keeps a young animal with its mother', () => {
    expect(thoughtFor({ ...base, dependent: true }).text).toBe('Staying close to its mother');
  });

  it('says so when the planner has no clear answer, instead of inventing one', () => {
    // The last row of spec §10.3. When the simulation does not have a clean answer, the bubble
    // says so. That is the difference between this product and the prototypes.
    const t = thoughtFor({ ...base, currentGoal: 'wander', goalScore: 0.09 });
    expect(t.text).toBe('Unclear — moving without an obvious goal');
    expect(t.confident).toBe(false);
  });

  it('never returns text without the facts it was built from', () => {
    for (const goal of ['find_food', 'find_water', 'rest', 'wander', 'hunt', 'scavenge', 'flee', 'breed'] as const) {
      const t = thoughtFor({ ...base, currentGoal: goal });
      expect(t.text.length).toBeGreaterThan(0);
      expect(t.basis.length).toBeGreaterThan(0);
    }
  });
});
