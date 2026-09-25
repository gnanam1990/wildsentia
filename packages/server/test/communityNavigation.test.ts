import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWorld, takeSnapshot } from '@vana/sim';
import { landWalkable } from '@vana/shared';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { Gateway } from '../src/gateway.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { LifeStore } from '../src/db/lifeStore.js';
import { testDatabaseUrl } from './testDatabase.js';
import { communityEventText, communityJourneyText, isCommunityPage, type CommunityPage } from '../../client/src/communityObserver.js';
import { isPersonHistoryPage } from '../../client/src/personHistory.js';
import { SceneUpdates } from '../../client/src/sceneUpdates.js';
import { CommunityPlayback } from '../../client/src/communityPlayback.js';
import { humanMotionAt } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const worldOptions = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialCommunityRulesVersion: 5 as const,
  initialAgents: {}, minPopulation: {} };
const options = () => ({ ...worldOptions, pool: pool!, landscape: null, snapshotEveryWorldHours: 1000 });
afterAll(async () => { await pool?.end(); });
maybe('durable cross-patch household journeys', () => {
  beforeEach(async () => { await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade'); });
  it('persists a v6 human hunt, carcass and raw-meat outcome in the checkpointed public village feed', async () => {
    const setup = { ...worldOptions, initialCommunityRulesVersion: 6 as const, initialAgents: { hare: 24 } };
    const seed = createWorld(setup), community = seed.community!, home = community.building.position;
    for (const person of community.people) person.needs.hunger = .7;
    community.stores.waterL = 30;
    for (let i = 0; i < seed.agents.length; i++) {
      const hare = seed.agents[i]!;
      hare.patchId = community.patchId;
      hare.position = { x: home.x + 5 + (i % 4) * 2, z: home.z + 5 + Math.floor(i / 4) * 2, heading: 0 };
    }
    const baseline = seed.totalNutrients();
    await new EventStore(pool!).appendBatch(seed.log.take());
    await new SnapshotStore(pool!).save(takeSnapshot(seed));
    const host = new SimHost({ ...options(), initialCommunityRulesVersion: 6, initialAgents: { hare: 24 } });
    await host.boot();
    const api = buildApi({ host, pool: pool! });
    try {
      await host.advance(1); await host.snapshotNow();
      const page = (await api.inject('/community')).json<CommunityPage>();
      expect(isCommunityPage(page)).toBe(true);
      expect(page.community!.version).toBe(6);
      const hunts = page.events.filter(e => e.type === 'human_hunt');
      expect(hunts.length).toBeGreaterThan(0);
      const success = hunts.find(e => e.outcome === 'success')!;
      expect(success).toBeDefined();
      expect(communityEventText(success)).toContain('raw meat taken');
      const map = (await api.inject('/event-map')).json<{ markers: Array<{ type: string; actorId: string; id: string }> }>();
      expect(map.markers.some(m => m.id === success.id && m.type === 'human_hunt'
        && m.actorId === success.conditions?.preyId)).toBe(true);
      expect(host.world.carcasses.some(c => c.id === success.conditions?.carcassId
        && c.originId === success.conditions?.preyId)).toBe(true);
      const history = await new EventStore(pool!).byActor(String(success.conditions?.preyId), 100);
      expect(history.some(e => e.type === 'died' && e.conditions.cause === 'predation')).toBe(true);
      expect(host.world.totalNutrients()).toBeCloseTo(baseline, 4);
    } finally { await api.close(); await host.abort(); }
  });

  it('restores a travelling person, commits the remote source transfer, serves real routes and retains collection history after pruning', async () => {
    // Explicit finite-resource fixture persisted before host boot. No preview data is used.
    const seed = createWorld(worldOptions), c = seed.community!, home = seed.patches[c.patchId]!;
    const source = seed.patches[home.neighbours.filter(id => landWalkable(seed.patches[id]) && seed.patches[id]!.habitat !== 'water').sort((a, b) => a - b)[0]!]!;
    for (const patch of seed.patches) { patch.plant.browse = 0; patch.capacity.browse = 0; }
    source.plant.browse = 100; c.stores.waterL = 20;
    for (const p of c.people) p.needs = { hunger: .1, thirst: .1, fatigue: .1 };
    seed.step(.01); const snapshot = takeSnapshot(seed);
    expect(snapshot.community!.version).toBe(5);
    expect(snapshot.community!.people[0]!.task).toMatchObject({ kind: 'gather_food', phase: 'travel', journey: { destinationPatchId: source.id } });
    await new EventStore(pool!).appendBatch(seed.log.take()); await new SnapshotStore(pool!).save(snapshot);
    const host = new SimHost(options()); await host.boot(); expect(host.world.community).toEqual(snapshot.community);
    const api = buildApi({ host, pool: pool! });
    try {
      const initial = (await api.inject('/community')).json<CommunityPage>(); expect(isCommunityPage(initial)).toBe(true);
      expect(communityJourneyText(initial.community!.people[0]!)).toContain(`Destination: patch ${source.id}`);
      const frames: string[] = [], gateway = new Gateway(host);
      gateway.handle({ send: data => frames.push(data), close() {} });
      let visible: unknown;
      const updates = new SceneUpdates({ prepare: async () => null, discard() {}, status() {}, commit(update) { visible = update.environment.community; } });
      expect(updates.receive(JSON.parse(frames[0]!), 0)).toBe(true); await Promise.resolve(); await Promise.resolve();
      expect(visible).toEqual(snapshot.community); gateway.close();
      const nutrients = host.world.totalNutrients();
      await host.advance(1);
      expect((await api.inject('/community')).json().community).toEqual(snapshot.community);
      await host.snapshotNow();
      const committed = (await api.inject('/community')).json<CommunityPage>(); expect(isCommunityPage(committed)).toBe(true);
      expect(committed.community!.motion!.endWorldTime).toBe(host.world.now());
      const recordedFrames: string[] = [], recordedGateway = new Gateway(host), player = new CommunityPlayback();
      recordedGateway.handle({ send: data => recordedFrames.push(data), close() {} });
      const scene = JSON.parse(recordedFrames[0]!);
      const recordedUpdates = new SceneUpdates({ prepare: async () => null, discard() {}, status() {}, commit(update) {
        player.apply(update.environment.community, update.frame, update.frameReceivedAt);
      } });
      expect(recordedUpdates.receive(scene, 1000)).toBe(true); await Promise.resolve(); await Promise.resolve();
      const trace = committed.community!.motion!.tracks[0]!;
      const i = trace.samples.findIndex((a, i) => a.phase === 'travel' && trace.samples[i + 1]
        && Math.hypot(a.position.x - trace.samples[i + 1]!.position.x, a.position.z - trace.samples[i + 1]!.position.z) > 0);
      expect(i).toBeGreaterThanOrEqual(0);
      const middle = (trace.samples[i]!.seconds + trace.samples[i + 1]!.seconds) / 2;
      const now = 1000 + (middle - scene.frame.elapsedWorldSeconds) / scene.frame.rate * 1000;
      const rendered = player.poses(now, false).get(trace.personId)!;
      const expectedPose = humanMotionAt(trace.samples, middle).position;
      expect(rendered.position.x).toBeCloseTo(expectedPose.x, 8); expect(rendered.position.z).toBeCloseTo(expectedPose.z, 8); expect(rendered.moving).toBe(true);
      const taskIds = [...new Set(committed.community!.motion!.tracks.flatMap(t => t.samples.map(s => s.taskEventId).filter(id => id !== null)))];
      const provenance = await pool!.query('select id from events where id = any($1::text[])', [taskIds]);
      expect(provenance.rows).toHaveLength(taskIds.length);
      recordedGateway.close();
      const collected = committed.events.filter(e => e.type === 'human_resource_collected');
      expect(collected.length).toBeGreaterThan(0);
      expect(collected.every(e => e.conditions?.sourcePatchId === source.id && e.effects!.foodKg! > 0)).toBe(true);
      expect(communityEventText(collected[0]!)).toContain(`recorded site: patch ${source.id}`);
      expect(host.world.community!.stores.foodKg).toBeGreaterThan(0);
      expect(host.world.totalNutrients()).toBeCloseTo(nutrients, 6);
      const actor = collected[0]!.actors[0]!;
      await new LifeStore(pool!).pruneRoutine(host.world.now() + 1);
      const history = (await api.inject(`/people/${actor}/events?limit=500`)).json();
      expect(isPersonHistoryPage(history, actor)).toBe(true);
      expect(history.events.some((e: { id: string }) => e.id === collected[0]!.id)).toBe(true);
      const saved = takeSnapshot(host.world); await host.abort();
      const next = new SimHost(options()); await next.boot(); expect(takeSnapshot(next.world)).toEqual(saved);
      expect(next.observation()!.community()!.motion).toEqual(saved.community!.motion);
      expect(next.liveEncounterFrame()).toBeNull(); // Recovery does not pretend the recording just happened again.
      const counts = await pool!.query("select count(*)::int as n, count(distinct causal_parents[1])::int as attempts from events where type = 'human_resource_collected'");
      expect(counts.rows[0].n).toBe(collected.length); expect(counts.rows[0].attempts).toBe(collected.length);
      expect((await api.inject({ method: 'POST', url: '/community', payload: { destination: source.id } })).statusCode).toBe(404);
    } finally { await api.close(); }
  });
});
