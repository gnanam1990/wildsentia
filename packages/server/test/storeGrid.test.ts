import { describe, expect, it } from 'vitest';
import { CONGO_GRID } from '@vana/shared';
import { EventStore } from '../src/db/eventStore.js';
import { LifeStore } from '../src/db/lifeStore.js';

// Congo plan 1A review: a store built without its world's grid silently read Congo events as the island's.
describe('event and life stores', () => {
  const pool = {} as never;
  it('refuse to be built without the grid of the world they serve', () => {
    expect(() => new EventStore(pool, undefined as never)).toThrow('grid');
    expect(() => new LifeStore(pool, undefined as never)).toThrow('grid');
  });
  it('accept the Congo grid', () => {
    expect(() => new EventStore(pool, CONGO_GRID)).not.toThrow();
    expect(() => new LifeStore(pool, CONGO_GRID)).not.toThrow();
  });
});
