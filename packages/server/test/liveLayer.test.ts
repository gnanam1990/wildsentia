import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { landWalkable, waterAccessPosition } from '@vana/shared';
import { createWorld, type World } from '@vana/sim';
import { IDLE_RELEASE_MS, LiveLayer, OPEN_SECONDS, type DropLedger, type PlaceDrop } from '../src/live/liveLayer.js';
import { randomLandSpot, worldPort } from '../src/live/worldPort.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const island = (): World => createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { sambar: 10, chital: 10 }, minPopulation: {} });

function setup(drops: DropLedger | null = null) {
  const world = island();
  let now = 1_000_000;
  const live = new LiveLayer(worldPort(() => world, () => 'w1'), drops, () => now);
  const run = (seconds: number) => { for (let i = 0; i < seconds * 10; i++) { now += 100; live.tick(0.1); } };
  return { world, live, run, advance: (ms: number) => { now += ms; }, now: () => now };
}

function ledger(drop: PlaceDrop) {
  const claims: string[] = [];
  const l: DropLedger = {
    active: () => [drop],
    spot: (_id, agentId) => { drop.spottedBy = agentId; },
    claim: vi.fn(async (_id, agentId) => { claims.push(agentId); return claims.length === 1 ? { ok: true as const, claimId: 'c1' } : { ok: false as const, reason: 'taken' }; }),
  };
  return { l, claims };
}

describe('live layer', () => {
  it('takes over a free animal of the chosen species and refuses a second one', () => {
    const { live, world } = setup();
    const result = live.possess('ag_1', 'Sora', { speciesId: 'chital' });
    expect(result.ok).toBe(true);
    const avatar = live.avatars.get('ag_1')!;
    expect(world.animal(avatar.animalId)!.controller).toBe('ag_1');
    expect(live.possess('ag_1', 'Sora', { speciesId: 'sambar' })).toEqual({ ok: false, reason: 'already_possessing' });
    expect(live.possess('ag_2', 'Kai', { animalId: avatar.animalId })).toEqual({ ok: false, reason: 'already_controlled' });
  });

  it('keeps the line waiting, without spinning, when a freed animal cannot be taken at once', () => {
    const world = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { sambar: 4, chital: 2 }, minPopulation: {} });
    let now = 1_000_000;
    const live = new LiveLayer(worldPort(() => world, () => 'w1'), null, () => now);
    expect(live.possess('ag_1', 'Sora', { speciesId: 'chital' }).ok).toBe(true);
    expect(live.possess('ag_2', 'Kai', { speciesId: 'chital' })).toEqual({ ok: false, reason: 'queued:1' });
    expect(live.possess('ag_3', 'Ren', { speciesId: 'chital' })).toEqual({ ok: false, reason: 'queued:2' });
    // Of two chital one may be steered. Both are mid-chase as ag_1's comes free, so nobody can take
    // one yet: the offer must not loop forever.
    const chital = world.agents.filter((a) => a.speciesId === 'chital').map((a) => a.id);
    for (const id of chital) live.wild.set(id, {} as never);
    expect(live.release('ag_1')).toBe(true);
    expect(live.avatars.has('ag_2')).toBe(false);
    // Both are still in line, in order: asking again shows the same places.
    expect(live.possess('ag_2', 'Kai', { speciesId: 'chital' })).toEqual({ ok: false, reason: 'queued:1' });
    expect(live.possess('ag_3', 'Ren', { speciesId: 'chital' })).toEqual({ ok: false, reason: 'queued:2' });
    // Once it is free, the first in line gets it when the next animal of the species ends.
    // Once the chase is over, the first in line gets one.
    for (const id of chital) live.wild.delete(id);
    expect(live.possess('ag_2', 'Kai', { speciesId: 'chital' }).ok).toBe(true);
    expect(live.possess('ag_3', 'Ren', { speciesId: 'chital' })).toEqual({ ok: false, reason: 'queued:1' });
  });

  it('walks at the species pace and runs only as long as its breath lasts', () => {
    const { live, world, run } = setup();
    live.possess('ag_1', 'Sora', { speciesId: 'chital' });
    const a = live.avatars.get('ag_1')!, start = { x: a.x, z: a.z };
    const motion = world.species.get('chital')!.locomotion;
    // A far point in a straight line over land, found by probing.
    const far = [1, -1].flatMap((s) => [{ x: start.x + s * 400, z: start.z }, { x: start.x, z: start.z + s * 400 }])
      .find((p) => live.moveTo('ag_1', [p], 'walk') === null)!;
    expect(far).toBeDefined();
    run(10);
    const walked = Math.hypot(a.x - start.x, a.z - start.z);
    expect(walked).toBeLessThanOrEqual(motion.walkMs * 10 + 1e-6);
    expect(walked).toBeGreaterThan(0);
    expect(world.animal(a.animalId)!.position).toMatchObject({ x: a.x, z: a.z });

    // Back and forth, so it is still running when its breath gives out.
    live.moveTo('ag_1', [far, start, far, start, far, start], 'run');
    const before = { x: a.x, z: a.z };
    run(1);
    expect(Math.hypot(a.x - before.x, a.z - before.z)).toBeLessThanOrEqual(motion.sprintMs + 1e-6);
    run(motion.sprintStaminaS + 2);
    expect(a.moving).toBe(true);
    expect(a.stamina).toBe(0); // Out of breath: now trotting, not sprinting.
    const trotFrom = { x: a.x, z: a.z };
    run(1);
    expect(Math.hypot(a.x - trotFrom.x, a.z - trotFrom.z)).toBeLessThanOrEqual(motion.trotMs + 1e-6);
  });

  it('refuses points off the island and stops where land ends', () => {
    const { live, world } = setup();
    live.possess('ag_1', 'Sora', { speciesId: 'sambar' });
    const sea = world.patches.find((p) => !landWalkable(p))!;
    expect(live.moveTo('ag_1', [{ x: sea.x * 300, z: sea.y * 300 }], 'walk')).toBe('not_on_land');
    expect(live.moveTo('ag_1', [{ x: Number.NaN, z: 0 }], 'walk')).toBe('not_on_land');
    expect(live.moveTo('ag_2', [{ x: 0, z: 0 }], 'walk')).toBe('not_possessing');
  });

  it('grazes through the ecology and drinks only at a water point', () => {
    const { live, world, run } = setup();
    live.possess('ag_1', 'Sora', { speciesId: 'sambar' });
    const a = live.avatars.get('ag_1')!, animal = world.animal(a.animalId)!;
    animal.drives.hunger = 0.8;
    expect(live.act('ag_1', 'graze')).toBeNull();
    run(31);
    expect(animal.drives.hunger).toBeLessThan(0.8);
    expect(live.act('ag_1', 'drink')).toBe('not_at_water');
    const wet = world.patches.filter((p) => landWalkable(p)).sort((x, y) => y.waterVolume - x.waterVolume)[0]!;
    const access = waterAccessPosition(wet.id);
    world.placeControlled(a.animalId, { x: access.x, z: access.z, heading: 0 }); a.x = access.x; a.z = access.z;
    animal.drives.thirst = 0.6;
    expect(live.act('ag_1', 'drink')).toBeNull();
    run(31);
    expect(animal.drives.thirst).toBeLessThan(0.6);
  });

  it('counts grazing, resting and feeding in world time, at the speed the world runs', () => {
    // At 12 world hours per real hour a body hungers 12 times faster than the wall clock, so
    // half a real minute of grazing must count as six world minutes, not thirty world seconds.
    for (const [rate, expected] of [[12, [360]], [200, [3600, 2400]]] as const) {
      const world = island();
      let now = 1_000_000;
      const port = worldPort(() => world, () => 'w1', { position: () => null, time: () => world.now(), rate: () => rate });
      const acted: number[] = [];
      const live = new LiveLayer({ ...port, act: (id, action, seconds) => { acted.push(seconds); return port.act(id, action, seconds); } }, null, () => now);
      live.possess('ag_1', 'Sora', { speciesId: 'sambar' });
      expect(live.act('ag_1', 'graze')).toBeNull();
      for (let i = 0; i < 300; i++) { now += 100; live.tick(0.1); }
      expect(acted.reduce((s, v) => s + v, 0)).toBeCloseTo(30 * rate, 3);
      expect(acted.map((v) => Math.round(v))).toEqual(expected); // Never more than an hour in one go.
    }
  });

  it('keeps the saved idle clock across a restart', () => {
    // A restart used to reset every possession's idle timer, so an abandoned animal was never freed
    // while the server kept being redeployed.
    const { live, world, run, now } = setup();
    live.possess('ag_1', 'Sora', { speciesId: 'sambar' });
    const a = live.avatars.get('ag_1')!;
    live.release('ag_1');
    expect(live.restore({ agentId: 'ag_1', agentName: 'Sora', animalId: a.animalId, x: a.x, z: a.z, heading: 0, since: 0,
      lastCommand: now() - IDLE_RELEASE_MS - 1 })).toBe(true);
    run(0.1);
    expect(live.avatars.has('ag_1')).toBe(false);
    expect(world.animal(a.animalId)!.controller).toBeUndefined();
  });

  it('lets go after 15 idle minutes, and ends when the animal dies', () => {
    const { live, world, run, advance } = setup();
    const ended: Array<{ agentId: string; how: string }> = [];
    live.onEnded = (life) => ended.push({ agentId: life.agentId, how: life.how });
    live.possess('ag_1', 'Sora', { speciesId: 'sambar' });
    const animalId = live.avatars.get('ag_1')!.animalId;
    advance(IDLE_RELEASE_MS + 1); run(0.1);
    expect(live.avatars.has('ag_1')).toBe(false);
    expect(world.animal(animalId)!.controller).toBeUndefined();
    expect(live.notices('ag_1').at(-1)!.text).toContain('idle');

    live.possess('ag_2', 'Kai', { speciesId: 'sambar' });
    const second = world.animal(live.avatars.get('ag_2')!.animalId)!;
    second.alive = false;
    run(0.1);
    expect(live.avatars.has('ag_2')).toBe(false);
    expect(live.notices('ag_2').at(-1)!.text).toContain('died');
    // Each end is recorded once, with how it happened, for the leaderboard.
    expect(ended).toEqual([{ agentId: 'ag_1', how: 'idle' }, { agentId: 'ag_2', how: 'died' }]);
  });

  it('spots a drop within ten metres, opens it in five seconds, and pays only the first', async () => {
    const { live, world, run } = setup();
    live.possess('ag_1', 'Sora', { speciesId: 'sambar' });
    live.possess('ag_2', 'Kai', { speciesId: 'chital' });
    const a = live.avatars.get('ag_1')!, b = live.avatars.get('ag_2')!;
    const drop: PlaceDrop = { id: 'd1', amountMicro: '2500000', x: a.x + 1, z: a.z, hintX: a.x + 20, hintZ: a.z, hintRadius: 40, expiresAt: Date.now() + 1e7, spottedBy: null };
    const { l, claims } = ledger(drop);
    const live2 = new LiveLayer(worldPort(() => world, () => 'w1'), l);
    for (const [id, name, av] of [['ag_1', 'Sora', a], ['ag_2', 'Kai', b]] as const)
      live2.restore({ agentId: id, agentName: name, animalId: av.animalId, x: drop.x + 1, z: drop.z, heading: 0, since: 0 });
    expect(live2.publicState().drops[0]).not.toHaveProperty('spotted');
    live2.tick(0.1);
    expect(drop.spottedBy).toBe('ag_1');
    expect(live2.publicState().drops[0]).toHaveProperty('spotted');
    expect(live2.openDrop('ag_1', 'd1')).toBeNull();
    expect(live2.openDrop('ag_2', 'd1')).toBeNull();
    for (let i = 0; i < OPEN_SECONDS * 10 + 2; i++) live2.tick(0.1);
    await Promise.resolve(); await Promise.resolve();
    expect(claims.length).toBe(1); // The second opener waits on the first claim, then the drop is gone.
    expect(live2.notices(claims[0]!).at(-1)!.text).toContain('won 2.5 USDC');
    void run;
  });

  it('cancels an open when the animal moves away, and refuses one out of reach', () => {
    const world = island();
    const probe = new LiveLayer(worldPort(() => world, () => 'w1'));
    probe.possess('ag_1', 'Sora', { speciesId: 'sambar' });
    const a = probe.avatars.get('ag_1')!;
    const drop: PlaceDrop = { id: 'd1', amountMicro: '1000000', x: a.x, z: a.z, hintX: a.x, hintZ: a.z, hintRadius: 40, expiresAt: 0, spottedBy: 'ag_1' };
    const { l, claims } = ledger(drop);
    const live = new LiveLayer(worldPort(() => world, () => 'w1'), l);
    live.restore({ agentId: 'ag_1', agentName: 'Sora', animalId: a.animalId, x: a.x, z: a.z, heading: 0, since: 0 });
    expect(live.openDrop('ag_1', 'missing')).toBe('no_such_drop');
    expect(live.openDrop('ag_1', 'd1')).toBeNull();
    for (let i = 0; i < 20; i++) live.tick(0.1);
    const away = [{ x: a.x + 30, z: a.z }, { x: a.x - 30, z: a.z }, { x: a.x, z: a.z + 30 }, { x: a.x, z: a.z - 30 }]
      .find((p) => live.moveTo('ag_1', [p], 'walk') === null)!;
    expect(away).toBeDefined();
    expect(live.avatars.get('ag_1')!.opening).toBeNull();
    for (let i = 0; i < 80; i++) live.tick(0.1);
    expect(claims.length).toBe(0);
    expect(live.openDrop('ag_1', 'd1')).toBe('too_far');
  });
});

describe('random place drops', () => {
  it('land on walkable ground away from pools', () => {
    const world = island();
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 50; i++) {
      const spot = randomLandSpot(world, random)!;
      const patch = world.patches.find((p) => Math.abs(p.x * 300 - spot.x) <= 150 && Math.abs(p.y * 300 - spot.z) <= 150)!;
      expect(landWalkable(patch)).toBe(true);
    }
  });
});

describe('live settings', () => {
  it('treats an empty compose value as unset and rejects nonsense', async () => {
    const { positiveSetting } = await import('../src/live/runtime.js');
    expect(positiveSetting({}, 'VANA_AGENT_SLOTS', 500)).toBe(500);
    expect(positiveSetting({ VANA_AGENT_SLOTS: '' }, 'VANA_AGENT_SLOTS', 500)).toBe(500);
    expect(positiveSetting({ VANA_AGENT_SLOTS: '250' }, 'VANA_AGENT_SLOTS', 500)).toBe(250);
    expect(() => positiveSetting({ VANA_AGENT_SLOTS: '0' }, 'VANA_AGENT_SLOTS', 500)).toThrow();
    expect(() => positiveSetting({ VANA_AGENT_SLOTS: 'many' }, 'VANA_AGENT_SLOTS', 500)).toThrow();
  });

  it('turns the holding gate on only with a valid amount and the holder token settings', async () => {
    const { holdingGate } = await import('../src/live/runtime.js');
    const holder = { VANA_HOLDER_ORIGIN: 'https://vana.example', VANA_HOLDER_CHAIN_ID: '8453', VANA_HOLDER_TOKEN_ADDRESS: `0x${'5'.repeat(40)}`,
      VANA_HOLDER_MIN_BALANCE_ATOMIC: '1', VANA_HOLDER_RPC_URL: 'https://rpc.example' };
    expect(holdingGate({})).toBeUndefined();
    expect(holdingGate({ VANA_AGENT_MIN_HOLDING_ATOMIC: '' })).toBeUndefined();
    expect(() => holdingGate({ VANA_AGENT_MIN_HOLDING_ATOMIC: '1000' })).toThrow(/VANA_HOLDER_/);
    expect(() => holdingGate({ ...holder, VANA_AGENT_MIN_HOLDING_ATOMIC: '-5' })).toThrow(/Invalid/);
    expect(holdingGate({ ...holder, VANA_AGENT_MIN_HOLDING_ATOMIC: '1000' })).toMatchObject({ minAtomic: 1000n, chainId: 8453 });
  });
});

describe('indexed lookups', () => {
  it('finds exactly the animals a full scan finds, nearest first', () => {
    const world = island(), port = worldPort(() => world, () => 'w');
    for (const [x, z, r] of [[3000, 3000, 150], [2900, 3600, 400], [100, 100, 150], [4200, 2000, 300]] as const) {
      const brute = world.agents.filter((a) => a.alive && a.position && Math.hypot(a.position.x - x, a.position.z - z) <= r)
        .sort((a, b) => Math.hypot(a.position!.x - x, a.position!.z - z) - Math.hypot(b.position!.x - x, b.position!.z - z)).map((a) => a.id);
      expect(port.nearby(x, z, r, 1000).map((a) => a.id)).toEqual(brute);
    }
    expect(port.nearby(-5000, 0, 150, 10)).toEqual([]);
    // The wild-hunter scan's shape: wide, cut to the nearest sixty.
    const brute = world.agents.filter((a) => a.alive && a.position && Math.hypot(a.position.x - 3000, a.position.z - 3000) <= 1200)
      .sort((a, b) => Math.hypot(a.position!.x - 3000, a.position!.z - 3000) - Math.hypot(b.position!.x - 3000, b.position!.z - 3000)).map((a) => a.id);
    expect(port.nearby(3000, 3000, 1200, 60).map((a) => a.id)).toEqual(brute.slice(0, 60));
  });

  it('lists free animals in one pass, never one that is held or raising young', () => {
    const world = island(), port = worldPort(() => world, () => 'w');
    const free = port.candidates(null, 1000);
    expect(free.length).toBeGreaterThan(0);
    for (const a of free) expect(world.possessionBlock(a.id)).toBeNull();
    expect(port.candidates('sambar', 2)).toHaveLength(2);
  });
});
