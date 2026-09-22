import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { EventLog } from '../src/events/log.js';

const base = {
  type: 'fed' as const, worldTime: 3600, simVersion: 'sim_0.1.0', patchId: 5, actors: ['a1'],
  conditions: { hunger: 0.7 }, outcome: 'success' as const,
  effects: { kg: 3 }, causalParents: [], confidence: 'authoritative' as const,
};

describe('EventLog', () => {
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
