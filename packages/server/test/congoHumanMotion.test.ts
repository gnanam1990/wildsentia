import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONGO_GRID } from '@vana/shared';
import { createWorld } from '@vana/sim';
import { HumanMotionStore } from '../src/db/humanMotionStore.js';

// A Congo village's people walk the 48 km grid: their recorded motion is checked on it, not on the
// island's, or the server's first hour fails and its checkpoint never commits (found in the demo).
describe('the Congo village\'s recorded motion', () => {
  it('is saved when checked on the Congo grid', async () => {
    const world = createWorld({ seed: 7, speciesDir: fileURLToPath(new URL('../../../config/species-congo', import.meta.url)),
      terrainProfile: 'congo_v1', communityProfile: 'household_v1', initialAgents: { blue_duiker: 200 }, minPopulation: {} });
    world.step(1);
    const motion = world.community!.motion!;
    expect(motion).toBeTruthy();
    const inserted: unknown[][] = [];
    const store = new HumanMotionStore({ query: async (_sql: string, values?: unknown[]) => { inserted.push(values ?? []); return { rows: [] }; } } as never);
    await expect(store.append([{ community: world.community!, motion }], CONGO_GRID)).resolves.toBeUndefined();
    expect(inserted.length).toBeGreaterThan(0);
  }, 120_000);
});
