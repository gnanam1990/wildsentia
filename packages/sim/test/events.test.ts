import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { EventLog } from '../src/events/log.js';

const base = {
  type: 'fed' as const, worldTime: 3600, simVersion: 'sim_0.1.0', patchId: 5, actors: ['a1'],
  conditions: { hunger: 0.7 }, outcome: 'success' as const,
  effects: { kg: 3 }, causalParents: [], confidence: 'authoritative' as const,
};

describe('EventLog', () => {
  it('detaches and freezes event-time coordinates so later movement cannot rewrite history', () => {
    const log = new EventLog(1, 'test');
    const position = { x: 1502.25, z: -20.75, heading: 1.1 };
    const event = log.append({ ...base, position });
    position.x += 10;
    expect(event.position).toEqual({ x: 1502.25, z: -20.75, heading: 1.1 });
    expect(Object.isFrozen(event.position)).toBe(true);
    const before = log.exportSequence();
    for (const invalid of [{ x: NaN, z: 0, heading: 0 }, { x: 0, z: 0, heading: 0 }, { x: 1500, z: 0, heading: Infinity }])
      expect(() => log.append({ ...base, position: invalid })).toThrow('recorded patch');
    expect(log.exportSequence()).toBe(before);
  });
  it('draining releases the actor index as well as the visible buffer', () => {
    const log = new EventLog(1, 'test');
    for (let i = 0; i < 100; i++) { log.append(base); log.take(); }
    expect(log.retainedCount()).toBe(0);
    expect(log.byActor('a1')).toEqual([]);
    expect(log.size()).toBe(100);
  });

  it('resumes exact IDs from durable sequence state without legacy collisions', () => {
    const a = new EventLog(1, 'test');
    const past = new Set(Array.from({ length: 1000 }, () => a.append(base).id));
    const b = new EventLog(1, 'test');
    b.restoreSequence(a.exportSequence());
    for (let i = 0; i < 1000; i++) {
      const id = a.append(base).id;
      expect(b.append(base).id).toBe(id);
      expect(past.has(id)).toBe(false);
      expect(id).toMatch(/^fed_[0-9a-f]{24}$/);
    }
    expect(() => b.restoreSequence(-1)).toThrow();
    expect(() => b.restoreSequence(NaN)).toThrow();
  });
  it('assigns a unique id to every event', () => {
    const log = new EventLog(1, 'sim_0.1.0');
    expect(new Set(Array.from({ length: 500 }, () => log.append(base).id)).size).toBe(500);
  });

  it('prefixes the id with the event type', () => {
    expect(new EventLog(1, 'sim_0.1.0').append(base).id).toMatch(/^fed_[0-9a-f]+$/);
  });

  it('is deterministic for the same seed', () => {
    expect(new EventLog(9, 'sim_0.1.0').append(base).id).toBe(new EventLog(9, 'sim_0.1.0').append(base).id);
  });

  it('returns a frozen view that cannot be mutated', () => {
    const log = new EventLog(1, 'sim_0.1.0');
    log.append(base);
    expect(() => (log.all() as WorldEvent[]).push({} as never)).toThrow();
  });

  it('indexes events by actor', () => {
    const log = new EventLog(1, 'sim_0.1.0');
    log.append({ ...base, actors: ['a1'] });
    log.append({ ...base, actors: ['a2'] });
    log.append({ ...base, actors: ['a1', 'a2'] });
    expect(log.byActor('a1')).toHaveLength(2);
    expect(log.byActor('a2')).toHaveLength(2);
  });
});
