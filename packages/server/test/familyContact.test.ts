import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { isMovementTrace } from '@vana/shared';
import { createWorld, takeSnapshot } from '@vana/sim';
import { LiveEncounterPlayer } from '../../client/src/liveEncounters.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { stripFloweringGuild } from '../../sim/test/legacySnapshot.js';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 5, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: { dhole: 2 }, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 12 });
afterAll(async () => { await pool?.end(); });
maybe('durable parental contact', () => {
  beforeEach(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
  });
  it('checkpoints both nursing approaches and daily intake, without replaying a feed after restart', async () => {
    const settings = { ...options(), initialAgents: { hare: 2 } };
    const initial = createWorld({ seed: settings.seed, speciesDir: settings.speciesDir,
      initialAgents: settings.initialAgents, minPopulation: {} });
    const snapshot = takeSnapshot(initial); snapshot.worldTime = 19 * 3600;
    const [mother, young] = snapshot.agents;
    stripFloweringGuild(snapshot.patches);
    for (const p of snapshot.patches) p.habitat = 'grassland';
    Object.assign(mother!, { patchId: 0, sex: 'female', pregnantSince: null, position: { x: -50, z: 0, heading: 0 },
      drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 }, offspringIds: [young!.id] });
    Object.assign(young!, { patchId: 0, dependentOn: mother!.id, motherId: mother!.id, ageDays: 5,
      lifeStage: 'newborn', massKg: 0.3, pregnantSince: null, position: { x: 100, z: 0, heading: 0 },
      drives: { hunger: 0.1, thirst: 0.2, fatigue: 0, fear: 0 },
      nursingSite: { patchId: 0, position: { x: 0, z: 0, heading: 0 }, establishedAt: 0, origin: 'birth' } });
    await new SnapshotStore(pool!).save(snapshot);
    const host = new SimHost(settings); await host.boot();
    const api = buildApi({ host, pool: pool! }); await api.ready();
    try {
      await host.advance(1);
      const path = `/animals/${young!.id}/events`;
      expect((await api.inject(path)).json().events.some((e: { type: string }) => e.type === 'provisioned')).toBe(false);
      expect(host.liveEncounterFrame()).toBeNull();
      await host.snapshotNow();
      const history = await new EventStore(pool!).recent(1000), feed = history.find(e => e.type === 'provisioned')!;
      expect(feed).toBeDefined(); expect(feed.conditions.schedule).toBe('daily_nursing');
      expect(feed.causalParents).toHaveLength(2);
      const routes = feed.causalParents.map(id => history.find(e => e.id === id)!);
      expect(routes.map(e => e.movement!.goal)).toEqual(['care_for_young', 'seek_nursing']);
      expect(Number(feed.conditions.arrivalWorldTime)).toBeCloseTo(Math.max(...routes.map(e =>
        e.movement!.startWorldTime + Number(e.effects.durationSeconds))));
      expect(feed.worldTime).toBeLessThan(host.world.now());
      expect((await api.inject(path)).json().events).toContainEqual(feed);
      const frame = JSON.parse(JSON.stringify(host.liveEncounterFrame()!));
      const player = new LiveEncounterPlayer(); expect(player.apply({ ...frame, elapsedWorldSeconds: 0 }, 0)).toBe(true);
      for (const actor of snapshot.agents) {
        expect(player.poses(0).get(actor.id)!.position.x).toBeCloseTo(actor.position!.x);
        expect(frame.movements.find((m: { actor: { id: string } }) => m.actor.id === actor.id).trace)
          .toEqual(routes.find(e => e.actors[0] === actor.id)!.movement);
      }
      const saved = structuredClone(host.world.agents.find(a => a.id === young!.id)!);
      expect(saved.nursingIntake).toMatchObject({ cycle: 0, completed: true });
      await host.abort();
      const restored = new SimHost(settings); await restored.boot();
      expect(restored.world.agents.find(a => a.id === saved.id)).toEqual(saved);
      expect(restored.liveEncounterFrame()).toBeNull();
      await restored.advance(1); await restored.snapshotNow();
      const after = restored.world.agents.find(a => a.id === saved.id)!;
      expect(after.nursingIntake).toEqual(saved.nursingIntake);
      expect(after.nursingSite).toEqual(saved.nursingSite);
      expect((await new EventStore(pool!).recent(1000)).filter(e => e.type === 'provisioned')).toEqual([feed]);
    } finally { await api.close(); }
  });
  it('publishes only saved care evidence, plays the real approach, and retains the visit on restart', async () => {
    const host = new SimHost(options()); await host.boot();
    const [parent, child] = host.world.agents;
    Object.assign(parent!, { patchId: 0, sex: 'female', pregnantSince: null, position: { x: -100, z: 0, heading: 0 },
      drives: { hunger: 0.2, thirst: 0.2, fear: 0, fatigue: 0 }, offspringIds: [child!.id] });
    Object.assign(child!, { patchId: 0, dependentOn: parent!.id, motherId: parent!.id, ageDays: 10, lifeStage: 'newborn',
      massKg: 2, position: { x: 100, z: 0, heading: 0 }, drives: { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 } });
    const start = { ...parent!.position! }, waiting = { ...child!.position! };
    await host.snapshotNow(); await host.advance(1);
    const api = buildApi({ host, pool: pool! }); await api.ready();
    try {
      expect(host.liveEncounterFrame()).toBeNull();
      expect((await api.inject(`/animals/${child!.id}/events`)).json().events.some((e: { type: string }) => e.type === 'provisioned')).toBe(false);
      await host.snapshotNow();
      const history = await new EventStore(pool!).recent(1000), visit = history.find(e => e.type === 'provisioned')!;
      expect(visit).toBeDefined(); expect(visit.position).toEqual(waiting);
      const move = history.find(e => e.id === visit.causalParents[0])!;
      expect(isMovementTrace(ISLAND_GRID, move.movement)).toBe(true);
      expect(move.movement!.goal).toBe('care_for_young');
      expect(Number(visit.conditions.arrivalWorldTime) + Number(visit.conditions.provisioningSeconds)).toBeCloseTo(3600);
      expect((await api.inject(`/animals/${child!.id}/events`)).json().events).toContainEqual(visit);
      const frame = JSON.parse(JSON.stringify(host.liveEncounterFrame()!));
      const movement = frame.movements.find((m: { actor: { id: string } }) => m.actor.id === parent!.id);
      expect(movement.trace).toEqual(move.movement);
      const player = new LiveEncounterPlayer(); expect(player.apply({ ...frame, elapsedWorldSeconds: 0 }, 0)).toBe(true);
      expect(player.poses(0).get(parent!.id)!.position.x).toBeCloseTo(start.x);
      const midway = player.poses(Number(visit.conditions.arrivalWorldTime) * 0.5 / frame.rate * 1000).get(parent!.id)!;
      expect(midway.position.x).toBeGreaterThan(start.x); expect(midway.position.x).toBeLessThan(parent!.position!.x);
      expect(child!.position).toEqual(waiting);
      const animals = structuredClone(host.world.agents); await host.abort();
      const restored = new SimHost(options()); await restored.boot();
      expect(restored.world.agents).toEqual(animals); expect(restored.liveEncounterFrame()).toBeNull();
      expect((await new EventStore(pool!).recent(1000)).find(e => e.id === visit.id)).toEqual(visit);
    } finally { await api.close(); }
  });
});
