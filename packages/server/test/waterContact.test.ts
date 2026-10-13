import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { atWaterAccess, isMovementTrace, waterContactPosition } from '@vana/shared';
import { LiveEncounterPlayer } from '../../client/src/liveEncounters.js';
import { displaySecondAt, paceMovement } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { SimHost } from './trackedHost.js';
import { testDatabaseUrl } from './testDatabase.js';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 44, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: { sambar: 4 }, minPopulation: {}, landscape: null });
afterAll(async () => { await pool?.end(); });
maybe('durable water contact evidence', () => {
  beforeEach(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
  });
  it('persists real approach traces, contact coordinates and linked drinking events through host restart', async () => {
    const host = new SimHost({ ...options(), snapshotEveryWorldHours: 12 }); await host.boot();
    for (const agent of host.world.agents) {
      agent.sex = 'male'; agent.drives = { hunger: 0, thirst: 0.85, fear: 0, fatigue: 0 };
      host.world.patches[agent.patchId]!.waterVolume = 1000;
    }
    await host.snapshotNow(); await host.advance(1);
    expect(host.liveEncounterFrame()).toBeNull(); // A volatile tick is not a playable observation.
    await host.snapshotNow();
    const frame = JSON.parse(JSON.stringify(host.liveEncounterFrame()!));
    const player = new LiveEncounterPlayer();
    expect(player.apply({ ...frame, elapsedWorldSeconds: 0 }, 0)).toBe(true);
    const events = new EventStore(pool!), history = await events.recent(1000), drinks = history.filter((e) => e.type === 'drank');
    expect(drinks.length).toBeGreaterThan(0);
    for (const drink of drinks) {
      expect(atWaterAccess(ISLAND_GRID, drink.position!, drink.patchId)).toBe(true);
      expect(drink.effects.litres).toBeGreaterThan(0); expect(drink.worldTime).toBe(3600);
      expect(drink.causalParents).toHaveLength(1);
      const approach = history.find((e) => e.id === drink.causalParents[0])!;
      expect(isMovementTrace(ISLAND_GRID, approach.movement)).toBe(true);
      expect(approach.movement!.completed).toBe(true);
      expect(approach.movement!.samples.at(-1)!.position.x).toBeCloseTo(drink.position!.x);
      expect(approach.effects.durationSeconds! + Number(drink.conditions.drinkingSeconds)).toBeCloseTo(3600);
      const route = frame.movements.find((m: { actor: { id: string } }) => m.actor.id === drink.actors[0]);
      expect(route.activity).toMatchObject({ eventId: drink.id, position: drink.position, litres: drink.effects.litres });
      expect(route.activity.startSeconds).toBeCloseTo(Number(drink.conditions.arrivalWorldTime));
      // Playback is paced for the viewer (pacing.ts): find when the recorded arrival is shown.
      const pacing = paceMovement(route.trace, route.actor.speciesId, frame.rate);
      const shownMs = (recorded: number) => displaySecondAt(pacing, recorded) / frame.rate * 1000;
      const beforeMs = shownMs(route.activity.startSeconds - 0.001);
      expect(player.poses(beforeMs).get(drink.actors[0]!)!.animal.state).toBe('travelling');
      const insideMs = shownMs(route.activity.startSeconds + 0.001);
      expect(player.poses(insideMs).get(drink.actors[0]!)).toMatchObject({ eventId: drink.id,
        animal: { state: 'drinking' }, position: { ...drink.position, moving: false } });
    }
    const animals = structuredClone(host.world.agents); await host.abort();
    const restored = new SimHost(options()); expect((await restored.boot()).restoredFrom).toBe(3600);
    expect(restored.world.agents).toEqual(animals);
    expect(restored.liveEncounterFrame()).toBeNull(); // Do not restart an old hour on process recovery.
    expect((await events.recent(1000)).filter((e) => e.type === 'drank')).toEqual(drinks);
  });
  it('publishes stationary contact from the actual starting position, including across hour boundaries', async () => {
    const host = new SimHost(options()); await host.boot();
    const makeThirsty = () => {
      for (const agent of host.world.agents) {
        agent.sex = 'male'; agent.drives = { hunger: 0, thirst: 0.85, fear: 0, fatigue: 0 };
        agent.position = waterContactPosition(ISLAND_GRID, agent.id, agent.patchId);
        host.world.patches[agent.patchId]!.waterVolume = 1000;
      }
    };
    for (let hour = 0; hour < 2; hour++) {
      makeThirsty(); await host.snapshotNow(); await host.advance(1);
      const frame = host.liveEncounterFrame()!;
      expect(frame.startWorldTime).toBe(hour * 3600);
      const history = await new EventStore(pool!).recent(1000);
      const drinks = history.filter(e => e.type === 'drank' && e.conditions.arrivalWorldTime === hour * 3600);
      expect(drinks.length).toBeGreaterThan(0);
      for (const drink of drinks) {
        const m = frame.movements!.find(m => m.actor.id === drink.actors[0])!;
        expect(m).toMatchObject({ eventId: drink.id, stationary: true,
          activity: { eventId: drink.id, startSeconds: 0, endSeconds: 3600 } });
        expect(m.trace.samples).toHaveLength(1); expect(drink.causalParents).toEqual([]);
      }
      const player = new LiveEncounterPlayer(); expect(player.apply(JSON.parse(JSON.stringify(frame)), 0)).toBe(true);
      for (const drink of drinks) expect(player.poses(0).get(drink.actors[0]!)!.animal.state).toBe('drinking');
    }
  });
});
