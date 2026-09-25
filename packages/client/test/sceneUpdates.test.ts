import { describe, expect, it, vi } from 'vitest';
import { SceneUpdates, type SceneUpdate } from '../src/sceneUpdates.js';
import { WorldStore } from '../src/protocol.js';
import { LiveEncounterPlayer } from '../src/liveEncounters.js';
import { TerrainCheckpoints, type PreparedTerrain } from '../src/terrainCheckpoints.js';

const animal = { id: 'sambar_1', speciesId: 'sambar', patchId: 0, state: 'resting', currentGoal: 'rest',
  drives: { hunger: 0.1, thirst: 0, fear: 0, fatigue: 0 } };
const scene = (id = 'a', time = 3600) => ({ type: 'scene', protocol: 1, checkpointId: id,
  world: { worldTime: time, nextEventSequence: time, season: 'wet', formatted: 'saved', population: { sambar: 1 }, worldHoursPerRealHour: 12 },
  animals: [animal], environment: { patches: [{ id: 0, x: 0, y: 0, habitat: 'grassland', elevation: 0.4,
    canopyCover: 0.5, grass: 100, browse: 50, water: 10 }], carcasses: [] }, frame: null });
const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('atomic checkpoint scene coordinator', () => {
  it('coordinates reusable real terrain through a superseded checkpoint without moving active resources early', async () => {
    const terrain = new TerrainCheckpoints(), store = new WorldStore();
    const gate = deferred<void>(); let pause = false;
    let visible: PreparedTerrain | null = null;
    const discarded: PreparedTerrain[] = [];
    const updates = new SceneUpdates<PreparedTerrain>({
      async prepare(environment) {
        const prepared = terrain.prepare(environment.patches);
        if (pause) { pause = false; await gate.promise; }
        return prepared;
      },
      discard(prepared) { discarded.push(prepared); terrain.discard(prepared); },
      commit(update, prepared) {
        if (prepared) { terrain.commit(prepared); visible = prepared; }
        store.replaceCheckpoint(update.world, update.animals);
      }, status: vi.fn(),
    });
    updates.receive(scene(), 0); await tick();
    const first = visible! as PreparedTerrain, ground = first.root.getObjectByName('ground');
    pause = true;
    const b = scene('b', 7200); b.environment.patches[0]!.grass = 500;
    updates.receive(b, 1);
    const c = scene('c', 10800); c.environment.patches[0]!.grass = 1000;
    updates.receive(c, 2);
    expect(store.world!.worldTime).toBe(3600);
    expect(first.root.getObjectByName('ground')).toBe(ground);
    gate.resolve(); await tick(); await tick(); await tick();
    expect(discarded).toHaveLength(1); expect(discarded[0]!.root.children).toHaveLength(0);
    expect(store.world!.worldTime).toBe(10800);
    expect((visible! as PreparedTerrain).root.getObjectByName('ground')).toBe(ground);
    expect(first.root.children).toHaveLength(0);
    terrain.dispose();
  });
  it('publishes world and animals only after the matching environment has prepared, notifying once', async () => {
    const store = new WorldStore(), ready = deferred<string>(), observations: unknown[] = [];
    let visibleTerrain = 'none';
    store.onChange(() => observations.push([visibleTerrain, store.world!.worldTime, [...store.animals.keys()]]));
    const updates = new SceneUpdates({ prepare: () => ready.promise, discard: vi.fn(), status: vi.fn(),
      commit: (update, prepared) => { visibleTerrain = prepared!; store.replaceCheckpoint(update.world, update.animals); } });
    expect(updates.receive(scene(), 0)).toBe(true);
    expect(store.world).toBeNull(); expect(store.animals.size).toBe(0); expect(observations).toEqual([]);
    ready.resolve('terrain-a'); await tick();
    expect(observations).toEqual([['terrain-a', 3600, ['sambar_1']]]);
  });

  it('coalesces same-checkpoint heartbeats while preparing without losing environment or a newer frame', async () => {
    const ready = deferred<string>(), commit = vi.fn(), prepare = vi.fn(() => ready.promise);
    const updates = new SceneUpdates({ prepare, commit, discard: vi.fn(), status: vi.fn() });
    updates.receive(scene(), 10);
    const { environment: _, ...heartbeat } = scene();
    updates.receive({ ...heartbeat, frame: { id: 'recording', startWorldTime: 0, endWorldTime: 3600,
      rate: 12, elapsedWorldSeconds: 20, encounters: [] } }, 20);
    ready.resolve('terrain'); await tick();
    expect(prepare).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0]).toMatchObject({ checkpointId: 'a', frameReceivedAt: 20,
      frame: { elapsedWorldSeconds: 20 }, environment: scene().environment });
    const { frame: _f, ...withoutFrame } = heartbeat;
    updates.receive(withoutFrame, 90); await tick();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls.at(-1)![0]).toMatchObject({ frameReceivedAt: 20, frame: { id: 'recording' } });
  });

  it('discards superseded prepared resources and keeps only the latest pending checkpoint', async () => {
    const ready = deferred<string>(), commit = vi.fn(), discard = vi.fn();
    const prepare = vi.fn().mockReturnValueOnce(ready.promise).mockResolvedValue('latest-terrain');
    const updates = new SceneUpdates<string>({ prepare, commit, discard, status: vi.fn() });
    updates.receive(scene('a'), 0);
    for (let i = 2; i <= 100; i++) updates.receive(scene(String(i), i * 3600), i);
    ready.resolve('obsolete-terrain'); await tick(); await tick();
    expect(discard).toHaveBeenCalledWith('obsolete-terrain'); expect(prepare).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1); expect(commit.mock.calls[0]![0].checkpointId).toBe('100');
  });

  it('invalidates in-flight preparations on disconnect and allows a restored lower clock only after reset', async () => {
    const ready = deferred<string>(), commit = vi.fn(), discard = vi.fn();
    const prepare = vi.fn().mockReturnValueOnce(ready.promise).mockResolvedValue('restored-terrain');
    const updates = new SceneUpdates<string>({ prepare, commit, discard, status: vi.fn() });
    updates.receive(scene('old', 7200), 0);
    expect(updates.receive(scene('restored', 3600), 1)).toBe(false);
    updates.reset(); expect(updates.receive(scene('restored', 3600), 2)).toBe(true);
    ready.resolve('obsolete'); await tick(); await tick();
    expect(discard).toHaveBeenCalledWith('obsolete'); expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0].checkpointId).toBe('restored');
  });

  it('retains the last complete scene on preparation failure and retries on a heartbeat', async () => {
    const commit = vi.fn(), status = vi.fn();
    const prepare = vi.fn().mockResolvedValueOnce('first').mockRejectedValueOnce(new Error('asset unavailable')).mockResolvedValueOnce('retry');
    const updates = new SceneUpdates<string>({ prepare, commit, discard: vi.fn(), status });
    updates.receive(scene(), 0); await tick();
    updates.receive(scene('b', 7200), 1); await tick();
    expect(commit).toHaveBeenCalledTimes(1); expect(status).toHaveBeenLastCalledWith('stale');
    const { environment: _, frame: _f, ...heartbeat } = scene('b', 7200);
    expect(updates.receive(heartbeat, 2)).toBe(true); await tick();
    expect(commit).toHaveBeenCalledTimes(2); expect(commit.mock.calls[1]![1]).toBe('retry');
  });

  it('rejects missing, mismatched and malformed data before preparing or changing visible state', () => {
    const prepare = vi.fn(), commit = vi.fn();
    const updates = new SceneUpdates({ prepare, commit, discard: vi.fn(), status: vi.fn() });
    const good = scene(); const { environment: _, ...noEnvironment } = good;
    for (const bad of [null, noEnvironment, { ...good, protocol: 2 }, { ...good, animals: [animal, animal] },
      { ...good, environment: { ...good.environment, patches: [{ ...good.environment.patches[0], water: NaN }] } },
      { ...good, world: { ...good.world, worldTime: -1 } },
      { ...good, frame: { id: 'wrong', startWorldTime: 3600, endWorldTime: 7200, rate: 12, elapsedWorldSeconds: 0, encounters: [] } }]) {
      expect(updates.receive(bad, 0)).toBe(false);
    }
    expect(prepare).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });

  it('requires finite aquatic-producer mass in a checkpointed micro-ecology scene', () => {
    const prepare = vi.fn(async () => true), commit = vi.fn();
    const updates = new SceneUpdates({ prepare, commit, discard: vi.fn(), status: vi.fn() });
    const good = scene();
    const micro = { updatedAt: good.world.worldTime, patches: [{ patchId: 0, antColonies: 0,
      fishSchools: 1, antBiomassKg: 0, pollinatorBiomassKg: 0, detritivoreBiomassKg: 0,
      aquaticProducerBiomassKg: 0.2, fishBiomassKg: 0.1,
      lastFishSpawnYear: 0, decomposerBiomassKg: 0 }] };
    expect(updates.receive({ ...good, environment: { ...good.environment, microEcology: {
      ...micro, patches: [{ ...micro.patches[0], aquaticProducerBiomassKg: Number.NaN }] } } }, 0)).toBe(false);
    expect(updates.receive({ ...good, environment: { ...good.environment, microEcology: micro } }, 0)).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('accepts only a finite checkpointed flowering-guild proxy, not invented visitor claims', () => {
    const prepare = vi.fn(async () => true);
    const updates = new SceneUpdates({ prepare, commit: vi.fn(), discard: vi.fn(), status: vi.fn() });
    const good = scene();
    const guild = { guildId: 'insect_visited_understorey_v1', vegetativeKg: 12,
      openKg: 0.1, visitedKg: 0.02, seedKg: 0,
      stage: 'flowering', nextEligibleAt: good.world.worldTime + 86400 };
    const withGuild = (floweringGuild: unknown) => ({ ...good, environment: { ...good.environment,
      patches: [{ ...good.environment.patches[0], habitat: 'riparian', floweringGuild }] } });
    expect(updates.receive(withGuild({ ...guild, visitedKg: NaN }), 0)).toBe(false);
    expect(updates.receive(withGuild({ ...guild, guildId: 'exact_bee_species' }), 0)).toBe(false);
    expect(updates.receive(withGuild(guild), 0)).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('accounts for preparation latency rather than restarting recorded movement on scene commit', async () => {
    const ready = deferred<string>(), player = new LiveEncounterPlayer();
    const updates = new SceneUpdates({ prepare: () => ready.promise, discard: vi.fn(), status: vi.fn(),
      commit: (update: SceneUpdate) => player.apply(update.frame, update.frameReceivedAt) });
    updates.receive({ ...scene(), frame: { id: 'frame', startWorldTime: 0, endWorldTime: 3600,
      rate: 12, elapsedWorldSeconds: 20, encounters: [] } }, 1000);
    ready.resolve('terrain'); await tick();
    expect(player.elapsed(6000)).toBe(80);
  });

  it('preserves recorded carcass position, size and decomposition stage in the same environment', async () => {
    const commit = vi.fn();
    const updates = new SceneUpdates({ prepare: async () => true, commit, discard: vi.fn(), status: vi.fn() });
    const value = scene();
    const corpse = { ...animal, id: 'dead-sambar', state: 'dead', decayStage: 4, sizeRatio: 0.7,
      position: { x: 0, z: 0, heading: 0.5 } };
    expect(updates.receive({ ...value, environment: { ...value.environment, carcasses: [corpse] } }, 0)).toBe(true);
    await tick();
    expect(commit.mock.calls[0]![0].environment.carcasses[0]).toMatchObject(corpse);
  });
});
