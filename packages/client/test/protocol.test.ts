import { describe, expect, it, vi } from 'vitest';
import { WorldStore } from '../src/protocol.js';

const worldMsg = {
  type: 'world', worldTime: 3600, formatted: 'Y01-monsoon-D01 01:00',
  season: 'monsoon', population: { sambar: 12 },
};
const animalsMsg = {
  type: 'animals',
  animals: [
    { id: 'sambar_0000', speciesId: 'sambar', patchId: 5, state: 'grazing',
      currentGoal: 'find_food', drives: { hunger: 0.4, thirst: 0.2, fatigue: 0.1, fear: 0 } },
  ],
};

describe('WorldStore', () => {
  it('starts empty', () => {
    const store = new WorldStore();
    expect(store.world).toBeNull();
    expect(store.animals.size).toBe(0);
  });

  it('applies a world message', () => {
    const store = new WorldStore();
    store.apply(worldMsg);
    expect(store.world!.season).toBe('monsoon');
    expect(store.world!.population.sambar).toBe(12);
  });

  it('keeps what the thought bubble reads, and leaves it unknown when the server omits it', () => {
    const store = new WorldStore();
    store.apply({
      type: 'animals',
      animals: [
        { ...animalsMsg.animals[0], alternativeGoal: 'flee', goalScore: 0.42, dependent: false },
        { ...animalsMsg.animals[0], id: 'sambar_0001' },
      ],
    });
    const told = store.animals.get('sambar_0000')!;
    expect(told.alternativeGoal).toBe('flee');
    expect(told.goalScore).toBe(0.42);
    expect(told.dependent).toBe(false);
    const silent = store.animals.get('sambar_0001')!;
    expect(silent.goalScore).toBeUndefined();
    expect(silent.dependent).toBeUndefined();
  });

  it('replaces the animal set on each animals message', () => {
    const store = new WorldStore();
    store.apply(animalsMsg);
    expect(store.animals.size).toBe(1);
    store.apply({ type: 'animals', animals: [] });
    expect(store.animals.size).toBe(0);
  });

  it('records viewer counts', () => {
    const store = new WorldStore();
    store.apply({ type: 'viewers', actorId: 'sambar_0000', count: 3 });
    expect(store.viewerCounts.get('sambar_0000')).toBe(3);
  });

  it('records a server error without throwing', () => {
    const store = new WorldStore();
    store.apply({ type: 'error', message: 'unsupported message type' });
    expect(store.lastError).toBe('unsupported message type');
  });

  it('ignores a malformed message rather than crashing the render loop', () => {
    const store = new WorldStore();
    expect(() => store.apply({ type: 'animals' })).not.toThrow();
    expect(() => store.apply(null)).not.toThrow();
    expect(() => store.apply({ nonsense: true })).not.toThrow();
    expect(store.animals.size).toBe(0);
  });

  it('notifies subscribers when state changes', () => {
    const store = new WorldStore();
    const spy = vi.fn();
    store.onChange(spy);
    store.apply(worldMsg);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
