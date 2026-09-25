import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { LifeStore } from '../src/db/lifeStore.js';
import { SimHost } from './trackedHost.js';
import { FOREST_LANDSCAPE, FOREST_POPULATION, SIM_VERSION, takeSnapshot, restoreSnapshot } from '@vana/sim';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { testDatabaseUrl } from './testDatabase.js';
import { isLiveEncounterFrame, LiveEncounterPlayer } from '../../client/src/liveEncounters.js';
import { Gateway } from '../src/gateway.js';
import type { LiveEncounterFrame } from '@vana/shared';
import { asLegacySnapshot } from '../../sim/test/legacySnapshot.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

const options = () => ({
  pool: pool!, seed: 7, speciesDir,
  snapshotEveryWorldHours: 24,
  initialAgents: { sambar: 20 }, minPopulation: { sambar: 20 }, landscape: null,
});

afterAll(async () => { await pool?.end(); });

maybe('SimHost', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive cascade');
  });

  it('boots a fresh world when there is no snapshot', async () => {
    const host = new SimHost(options());
    const result = await host.boot();
    expect(result.restoredFrom).toBeNull();
    expect(host.world.livingCount('sambar')).toBe(20);
  });

  it('persists actual ordinary routes and restores their authoritative endpoints', async () => {
    const config = { ...options(), initialAgents: { sambar: 2 }, minPopulation: {}, snapshotEveryWorldHours: 1 };
    const host = new SimHost(config); await host.boot();
    for (const agent of host.world.agents) {
      agent.sex = 'male'; agent.drives = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 };
    }
    await host.advance(1);
    const routes = (await new EventStore(pool!).recent(100)).filter((e) => e.movement);
    expect(routes.length).toBeGreaterThan(0);
    const frame = host.liveEncounterFrame()!;
    expect(isLiveEncounterFrame(frame)).toBe(true);
    expect(frame.movements?.length).toBe(routes.length);
    expect(frame.endWorldTime).toBe((await new SnapshotStore(pool!).loadLatest())!.worldTime);
    const player = new LiveEncounterPlayer();
    expect(player.apply(JSON.parse(JSON.stringify({ ...frame, elapsedWorldSeconds: 0 })), 0)).toBe(true);
    for (const event of routes) {
      const trace = event.movement!;
      expect(trace.samples.length).toBeGreaterThan(1);
      expect(trace.startWorldTime).toBe(0);
      expect(event.worldTime).toBe(Math.floor(trace.samples.at(-1)!.seconds));
      const agent = host.world.agents.find((a) => a.id === trace.actorId)!;
      expect(agent.position).toEqual(trace.samples.at(-1)!.position);
      expect(frame.movements!.find((m) => m.eventId === event.id)!.trace).toEqual(trace);
      const first = trace.samples[0]!.position, next = trace.samples[1]!.position;
      expect(player.poses(0).get(agent.id)!.position).toMatchObject({ x: first.x, z: first.z,
        heading: Math.atan2(next.x - first.x, next.z - first.z), moving: true });
    }
    const before = takeSnapshot(host.world);
    await host.stop();
    const restored = new SimHost(config); await restored.boot();
    expect(takeSnapshot(restored.world)).toEqual(before);
    expect(restored.liveEncounterFrame()).toBeNull();
    expect((await new EventStore(pool!).recent(100)).filter((e) => e.movement)).toEqual(routes);
  });

  it('withholds ordinary route publication until the matching world snapshot succeeds', async () => {
    const host = new SimHost({ ...options(), initialAgents: { sambar: 2 }, minPopulation: {} });
    await host.boot();
    for (const a of host.world.agents) { a.sex = 'male'; a.drives = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 }; }
    await host.advance(1);
    const route = (await new EventStore(pool!).recent(100)).find((e) => e.movement)!;
    expect(route).toBeDefined();
    expect(host.liveEncounterFrame()).toBeNull();
    expect(host.liveEncounterFrame(route.movement!.actorId)).toBeNull();
    await host.snapshotNow();
    expect(host.liveEncounterFrame()!.movements!.length).toBeGreaterThan(0);
  });

  it('retains routes beyond the wire cap and prioritizes the followed actor without changing the world', async () => {
    const config = { ...options(), initialAgents: { sambar: 2052 }, minPopulation: {}, snapshotEveryWorldHours: 1 };
    const host = new SimHost(config); await host.boot();
    for (const a of host.world.agents) { a.sex = 'male'; a.drives = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 }; }
    await host.advance(1);
    const ordinary = host.liveEncounterFrame()!;
    expect(ordinary.movements).toHaveLength(2048);
    const shown = new Set(ordinary.movements!.map((m) => m.actor.id));
    const overflow = (await new EventStore(pool!).recent(20_000)).find((e) => e.movement && !shown.has(e.movement.actorId))!;
    expect(overflow).toBeDefined();
    const id = overflow.movement!.actorId;
    const before = takeSnapshot(host.world);
    const priority = host.liveEncounterFrame(id)!;
    expect(priority.id).toBe(ordinary.id);
    expect(priority.startWorldTime).toBe(ordinary.startWorldTime);
    expect(priority.elapsedWorldSeconds).toBeGreaterThanOrEqual(ordinary.elapsedWorldSeconds);
    expect(priority.movements).toHaveLength(2048);
    expect(priority.movements![0]).toMatchObject({ eventId: overflow.id, trace: overflow.movement });
    expect(isLiveEncounterFrame(JSON.parse(JSON.stringify(priority)))).toBe(true);
    expect(takeSnapshot(host.world)).toEqual(before);
    expect(host.liveEncounterFrame()!.movements).toEqual(ordinary.movements);
    const gateway = new Gateway(host);
    const sent: Array<{ type: string; frame?: LiveEncounterFrame }> = [];
    const socket = { send: (s: string) => { sent.push(JSON.parse(s)); }, close: () => {} };
    gateway.handle(socket);
    const player = new LiveEncounterPlayer();
    const initial = sent.find((m) => m.type === 'scene')!.frame!;
    expect(player.apply(initial, 0)).toBe(true);
    expect(player.poses(0).has(id)).toBe(false);
    gateway.receive(socket, { type: 'watch', actorId: id }); gateway.broadcast();
    const selected = sent.findLast((m) => m.type === 'scene')!.frame!;
    expect(selected.movements![0]!.actor.id).toBe(id);
    expect(player.apply(selected, 500)).toBe(true);
    expect(player.poses(500).has(id)).toBe(true);
    expect(takeSnapshot(host.world)).toEqual(before);
    gateway.disconnect(socket); gateway.close();
    await host.stop(); const restored = new SimHost(config); await restored.boot();
    expect(restored.liveEncounterFrame(id)).toBeNull();
  });

  it('streams actual checkpointed hunt traces, with durable provenance and no restart replay', async () => {
    const config = { ...options(), seed: 1, initialAgents: FOREST_POPULATION, minPopulation: {}, snapshotEveryWorldHours: 1 };
    const host = new SimHost(config); await host.boot();
    for (let h = 0; h < 12 && !host.liveEncounterFrame()?.encounters.length; h++) await host.advance(1);
    const frame = host.liveEncounterFrame()!;
    expect(frame.encounters.length).toBeGreaterThan(0);
    expect(isLiveEncounterFrame(JSON.parse(JSON.stringify(frame)))).toBe(true);
    expect(frame.movements!.length).toBeGreaterThan(0);
    expect(frame.endWorldTime).toBe((await new SnapshotStore(pool!).loadLatest())!.worldTime);
    for (const e of frame.encounters) {
      const stored = (await new EventStore(pool!).byActor(e.predator.id, 100)).find((x) => x.id === e.eventId)!;
      expect(stored.encounter).toEqual(e.trace);
      expect(stored.outcome).toBe(e.outcome);
      expect(e.prey.id).toBe(e.trace.preyId);
    }
    await host.stop();
    const restored = new SimHost(config); await restored.boot();
    expect(restored.liveEncounterFrame()).toBeNull();
    expect(restored.world.now()).toBe(frame.endWorldTime);
  });

  it.each(['sim_0.5.0', 'sim_0.6.0', 'sim_0.7.0', 'sim_0.8.0', 'sim_0.9.0', 'sim_0.10.0', 'sim_0.11.0', 'sim_0.12.0'])('refuses silent %s rules upgrades and durably records explicit upgrade once', async (from) => {
    const first = new SimHost(options()); await first.boot();
    const legacy = asLegacySnapshot(takeSnapshot(first.world), from);
    await first.abort();
    await new SnapshotStore(pool!).save(legacy);
    await expect(new SimHost(options()).boot()).rejects.toThrow('refusing to boot');
    const upgraded = new SimHost({ ...options(), allowV5Upgrade: from === 'sim_0.5.0', allowV6Upgrade: from === 'sim_0.6.0', allowV7Upgrade: from === 'sim_0.7.0', allowV8Upgrade: from === 'sim_0.8.0', allowV9Upgrade: from === 'sim_0.9.0', allowV10Upgrade: from === 'sim_0.10.0', allowV11Upgrade: from === 'sim_0.11.0', allowV12Upgrade: from === 'sim_0.12.0' }); await upgraded.boot();
    expect(upgraded.world.agents).toEqual(first.world.agents);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    const events = await new EventStore(pool!).recent(100);
    expect(events.filter((e) => e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    const original = await pool!.query('select count(*) from snapshots where sim_version = $1', [from]);
    expect(Number(original.rows[0].count)).toBe(1);
    await upgraded.abort();
    await new SimHost(options()).boot();
    expect((await new EventStore(pool!).recent(100)).filter((e) => e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
  });

  it.each(['sim_0.17.0', 'sim_0.18.0'])('requires explicit %s opt-in and zeroes absent aquatic producer history', async (from) => {
    const first = new SimHost(options()); await first.boot();
    const saved = asLegacySnapshot(takeSnapshot(first.world), from);
    for (const patch of saved.microEcology!.patches)
      delete (patch as { aquaticProducerBiomassKg?: number }).aquaticProducerBiomassKg;
    await first.abort();
    await new SnapshotStore(pool!).save(saved);
    await expect(new SimHost(options()).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...options(), allowV17Upgrade: from === 'sim_0.17.0',
      allowV18Upgrade: from === 'sim_0.18.0' });
    await upgraded.boot();
    expect(upgraded.world.microEcology.patches.every(patch => patch.aquaticProducerBiomassKg === 0)).toBe(true);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    expect((await new EventStore(pool!).recent(100)).filter(e => e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    await upgraded.abort();
    const restored = new SimHost(options()); await restored.boot();
    expect(restored.world.microEcology).toEqual(upgraded.world.microEcology);
  });

  it('refuses a v0.19 island save without explicit freshwater-basin upgrade opt-in', async () => {
    const island = { ...options(), seed: 1, terrainProfile: 'island_v1' as const,
      initialAgents: {}, minPopulation: {} };
    const first = new SimHost(island); await first.boot();
    const old = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.19.0');
    const basinIds = old.patches.filter(p => p.surface === 'land' && p.habitat === 'water').map(p => p.id);
    for (const id of basinIds) {
      const patch = old.patches[id]!;
      patch.habitat = 'marsh'; patch.capacity = { grass: 3500, browse: 900 };
      patch.plant = { grass: 123, browse: 45 }; patch.waterVolume = 813;
    }
    old.waterBudget!.initialL = old.patches.reduce((n, p) => n + p.waterVolume, 0);
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(island).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...island, allowV19Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.patches.filter(p => p.surface === 'land' && p.habitat === 'water')).toHaveLength(2);
    for (const id of basinIds) expect(upgraded.world.patches[id]!.waterVolume).toBe(813);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    expect((await new EventStore(pool!).recent(100)).filter(e =>
      e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    await upgraded.abort();
    const restarted = new SimHost(island); await restarted.boot();
    expect(restarted.world.patches.map(p => p.habitat)).toEqual(upgraded.world.patches.map(p => p.habitat));
  });

  it('refuses v0.20 illness rules without opt-in and never invents past disease', async () => {
    const first = new SimHost(options()); await first.boot();
    const old = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.20.0');
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(options()).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...options(), allowV20Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.agents.every(a => a.illness === undefined)).toBe(true);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    expect((await new EventStore(pool!).recent(100)).filter(e =>
      e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    await upgraded.abort();
    const restarted = new SimHost(options()); await restarted.boot();
    expect(restarted.world.agents.every(a => a.illness === undefined)).toBe(true);
  });

  it('refuses v0.21 care/founder rules without opt-in and preserves a young boar on upgrade', async () => {
    const config = { ...options(), initialAgents: { boar: 2 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const old = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.21.0');
    const young = old.agents[0]!;
    young.dependentOn = old.agents[1]!.id;
    young.ageDays = 7;
    young.lastMaternalWaterAt = undefined;
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(config).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...config, allowV21Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.agents[0]!.lastMaternalWaterAt).toBe(old.worldTime);
    expect(upgraded.world.agents[0]!.drives).toEqual(old.agents[0]!.drives);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    expect((await new EventStore(pool!).recent(100)).filter(e =>
      e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    await upgraded.abort();
    const restarted = new SimHost(config); await restarted.boot();
    expect(restarted.world.agents[0]!.lastMaternalWaterAt).toBe(old.worldTime);
  });

  it('refuses v0.22 tiger-water rules without opt-in and does not hydrate a saved cub', async () => {
    const config = { ...options(), initialAgents: { tiger: 2 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const old = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.22.0');
    old.agents[0]!.ageDays = 80;
    old.agents[0]!.dependentOn = old.agents[1]!.id;
    old.agents[0]!.drives.thirst = 0.8;
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(config).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...config, allowV22Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.agents[0]!.drives.thirst).toBe(0.8);
    expect(upgraded.world.agents[0]!.position).toEqual(old.agents[0]!.position);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    expect((await new EventStore(pool!).recent(100)).filter(e =>
      e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    await upgraded.abort();
    const restarted = new SimHost(config); await restarted.boot();
    expect(restarted.world.agents[0]!.drives.thirst).toBe(0.8);
  });

  it('refuses v0.23 tiger-meat rules without opt-in and does not feed or move a saved cub', async () => {
    const config = { ...options(), initialAgents: { tiger: 2 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const old = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.23.0');
    old.agents[0]!.ageDays = 80;
    old.agents[0]!.dependentOn = old.agents[1]!.id;
    old.agents[0]!.drives.hunger = 0.8;
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(config).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...config, allowV23Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.agents[0]!.drives.hunger).toBe(0.8);
    expect(upgraded.world.agents[0]!.position).toEqual(old.agents[0]!.position);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    expect((await new EventStore(pool!).recent(100)).filter(e =>
      e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    await upgraded.abort();
    const restarted = new SimHost(config); await restarted.boot();
    expect(restarted.world.agents[0]!.drives.hunger).toBe(0.8);
  });

  it('refuses v0.24 arboreal rules without opt-in and leaves saved ground agents untouched', async () => {
    const config = { ...options(), initialAgents: { langur: 2, squirrel: 2 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const old = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.24.0');
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(config).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...config, allowV24Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.agents).toEqual(old.agents);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    expect((await new EventStore(pool!).recent(100)).filter(e =>
      e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    await upgraded.abort();
    const restarted = new SimHost(config); await restarted.boot();
    expect(restarted.world.agents).toEqual(old.agents);
  });

  it('refuses v0.25 wound rules without opt-in and leaves saved agents untouched', async () => {
    const config = { ...options(), initialAgents: { chital: 2 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const old = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.25.0');
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(config).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...config, allowV25Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.agents).toEqual(old.agents);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    expect((await new EventStore(pool!).recent(100)).filter(e =>
      e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    await upgraded.abort();
    const restarted = new SimHost(config); await restarted.boot();
    expect(restarted.world.agents).toEqual(old.agents);
  });

  it('rejects future wound state smuggled into a pre-wound checkpoint even with upgrade opt-in', async () => {
    const config = { ...options(), initialAgents: { chital: 2 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const forged = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.25.0');
    forged.agents[0]!.wound = { kind: 'contact_injury', phase: 'open', sourceHuntEventId: 'hunt_fake',
      woundEventId: 'wound_fake', acquiredAt: 0, lastUpdatedAt: 0, severity: 0.3,
      recoveryRemainingHours: 10, infectionBudget: 1, mortalityBudget: 1 };
    await first.abort();
    await new SnapshotStore(pool!).save(forged);
    await expect(new SimHost({ ...config, allowV25Upgrade: true }).boot()).rejects.toThrow(/future wound state/);
  });

  it('requires explicit v0.26 fish-cohort rules upgrade and starts with zero historical eggs', async () => {
    const config = { ...options(), initialAgents: { chital: 2 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const old = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.26.0');
    for (const patch of old.microEcology!.patches) delete (patch as Partial<typeof patch>).lastFishSpawnYear;
    old.agents[0]!.wound = { kind: 'contact_injury', phase: 'open', sourceHuntEventId: 'hunt_prior',
      woundEventId: 'wounded_prior', acquiredAt: 0, lastUpdatedAt: 0, severity: 0.2,
      recoveryRemainingHours: 24, infectionBudget: 1, mortalityBudget: 1 };
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(config).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...config, allowV26Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.microEcology.patches.every(patch => patch.fishCohort === undefined
      && patch.lastFishSpawnYear === 1)).toBe(true);
    expect(upgraded.world.agents[0]!.wound).toEqual(old.agents[0]!.wound);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    await upgraded.abort();
  });

  it('rejects an invented future fish cohort in an old snapshot even with upgrade opt-in', async () => {
    const config = { ...options(), initialAgents: { chital: 2 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const forged = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.26.0');
    forged.microEcology!.patches[0]!.fishCohort = { stage: 'eggs', biomassKg: 0.01,
      spawnedAt: 0, hatchAt: 7200, recruitAt: 72_000 };
    await first.abort();
    await new SnapshotStore(pool!).save(forged);
    await expect(new SimHost({ ...config, allowV26Upgrade: true }).boot())
      .rejects.toThrow(/future fish cohort state/);
  });

  it('requires explicit v0.27 flowering upgrade and preserves a genuine fish cohort', async () => {
    const config = { ...options(), initialAgents: { chital: 2 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const old = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.27.0');
    const fish = old.microEcology!.patches.find(patch => patch.fishBiomassKg > 0)!;
    fish.fishBiomassKg -= 0.001;
    fish.fishCohort = { stage: 'eggs', biomassKg: 0.001,
      spawnedAt: 0, hatchAt: 7200, recruitAt: 22 * 86400 };
    fish.lastFishSpawnYear = 1;
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(config).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...config, allowV27Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.microEcology.patches[fish.patchId]).toEqual(fish);
    expect(upgraded.world.patches.some(patch => patch.floweringGuild?.bloom)).toBe(false);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    await upgraded.abort();
  });

  it('requires explicit v0.28 mate-response upgrade and retains existing flowering state', async () => {
    const config = { ...options(), initialAgents: { dhole: 3 }, minPopulation: {} };
    const first = new SimHost(config); await first.boot();
    const old = takeSnapshot(first.world); old.simVersion = 'sim_0.28.0';
    await first.abort();
    await new SnapshotStore(pool!).save(old);
    await expect(new SimHost(config).boot()).rejects.toThrow(/refusing to boot/);
    const upgraded = new SimHost({ ...config, allowV28Upgrade: true }); await upgraded.boot();
    expect(upgraded.world.agents).toEqual(old.agents);
    expect(upgraded.world.patches).toEqual(old.patches);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    await upgraded.abort();
  });

  it('can restart before its first tick without regenerating founder event IDs', async () => {
    const first = new SimHost(options());
    await first.boot();
    const sequence = first.world.log.exportSequence();
    await first.stop();
    const second = new SimHost(options());
    expect((await second.boot()).restoredFrom).toBe(0);
    expect(second.world.log.exportSequence()).toBe(sequence);
  });

  it('boots the whole forest by default, not a single species', async () => {
    // No population overrides: this is exactly what the live server constructs.
    const host = new SimHost({ pool: pool!, seed: 7, speciesDir });
    await host.boot();

    const present = new Set(host.world.agents.map((a) => a.speciesId));
    expect(present.size).toBe(12);
    expect([...present].sort()).toEqual([...host.world.species.keys()].sort());
    for (const [speciesId, count] of Object.entries(FOREST_POPULATION)) {
      expect(host.world.livingCount(speciesId)).toBe(count);
    }
    expect(host.worldOptions.landscape).toEqual(FOREST_LANDSCAPE);
  });

  it('samples where every animal is, every few world hours', async () => {
    const host = new SimHost({ ...options(), trackEveryWorldHours: 6 });
    await host.boot();
    await host.advance(13);
    const id = host.world.agents[0]!.id;
    const track = await new LifeStore(pool!).trackOf(id);
    expect(track.map((p) => p.worldTime)).toEqual([6 * 3600, 12 * 3600]);
    expect(track[1]!.patchId).toBeGreaterThanOrEqual(0);
  });

  it('prunes routine events past their window, keeping the rest', async () => {
    const host = new SimHost({ ...options(), routineRetentionWorldDays: 1, housekeepingEveryWorldHours: 24 });
    await host.boot();
    await host.advance(24 * 3);
    const { rows } = await pool!.query<{ n: string }>(
      "select count(*) as n from events where type = 'moved' and world_time < $1", [(3 - 1) * 86_400],
    );
    expect(Number(rows[0]!.n)).toBe(0);
    const { rows: recent } = await pool!.query<{ n: string }>(
      "select count(*) as n from events where type = 'moved' and world_time >= $1", [2 * 86_400],
    );
    expect(Number(recent[0]!.n)).toBeGreaterThan(0);
  });

  it('archives the long departed and lets the world forget them', async () => {
    // Tigers with nothing to hunt starve within a couple of weeks.
    const host = new SimHost({
      ...options(), initialAgents: { tiger: 3 }, minPopulation: {},
      archiveAfterWorldDays: 1, housekeepingEveryWorldHours: 24,
    });
    await host.boot();
    await host.advance(24 * 30);
    const { rows } = await pool!.query<{ id: string }>('select id from animal_archive');
    expect(rows.length).toBeGreaterThan(0);
    for (const { id } of rows) expect(host.world.deceased.some((a) => a.id === id)).toBe(false);
    expect((await new LifeStore(pool!).archived(rows[0]!.id))?.alive).toBe(false);
  });

  it('persists events as the world advances', async () => {
    const host = new SimHost(options());
    await host.boot();
    await host.advance(48);
    expect(await new EventStore(pool!).total()).toBeGreaterThan(0);
  });

  it('resumes from the newest snapshot after a restart', async () => {
    const first = new SimHost(options());
    await first.boot();
    await first.advance(48);
    await first.stop();
    const timeBefore = first.world.now();

    const second = new SimHost(options());
    const result = await second.boot();

    expect(result.restoredFrom).toBe(timeBefore);
    expect(second.world.now()).toBe(timeBefore);
    expect(second.world.agents.map((a) => a.id)).toEqual(first.world.agents.map((a) => a.id));
  });

  it('inserts every new event after restart without colliding with retained history', async () => {
    const first = new SimHost(options());
    await first.boot();
    await first.advance(100);
    await first.snapshotNow();
    await first.abort();
    const second = new SimHost(options());
    await second.boot();
    const count = await new EventStore(pool!).total();
    const start = second.world.log.exportSequence();
    // Avoid housekeeping retention so the row-count invariant measures inserts alone.
    for (let i = 0; i < 10; i++) second.world.step(1);
    const emitted = second.world.log.exportSequence() - start;
    await second.flush();
    expect(await new EventStore(pool!).total()).toBe(count + emitted);
  });

  it('continues deterministically from the restored state', async () => {
    const first = new SimHost(options());
    await first.boot();
    await first.advance(24);
    await first.stop();

    const second = new SimHost(options());
    await second.boot();

    const reference = restoreSnapshot(takeSnapshot(first.world), first.worldOptions);
    for (let h = 0; h < 24; h++) reference.step(1);
    await second.advance(24);

    expect(second.world.agents.map((a) => [a.id, a.patchId, a.drives.hunger]))
      .toEqual(reference.agents.map((a) => [a.id, a.patchId, a.drives.hunger]));
  });

  it('rolls back events that outlived the newest snapshot and records why', async () => {
    const host = new SimHost(options());
    await host.boot();
    await host.advance(24);
    await host.snapshotNow();
    const snapshotTime = host.world.now();
    await host.advance(6);
    await host.flush();

    const store = new EventStore(pool!);
    expect(await store.countAfter(snapshotTime)).toBeGreaterThan(0);
    await host.abort();

    const restarted = new SimHost(options());
    const result = await restarted.boot();

    expect(result.rolledBackEvents).toBeGreaterThan(0);
    expect(await store.countAfter(snapshotTime)).toBe(0);
    expect((await store.recent(5)).some((e) => e.type === 'maintenance')).toBe(true);
  });
});
