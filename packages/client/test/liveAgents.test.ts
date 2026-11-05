import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LiveAgents, activityOf, playoutDelay, isLiveMessage, isRosterMessage, rosterActivity, usdc, type LiveMessage } from '../src/liveAgents.js';
import type { AnimalState } from '../src/protocol.js';

const avatar = (x: number, extra = {}) => ({ agentId: 'ag_1', name: 'Sora', animalId: 'chital_0001', speciesId: 'chital', x, z: 0, heading: 0,
  gait: 'walk' as const, moving: true, action: 'idle' as const, opening: null, ...extra });
const message = (at: number, x: number, drops: LiveMessage['drops'] = []): LiveMessage => ({ type: 'live', at, avatars: [avatar(x)], drops });
const animals = new Map<string, AnimalState>([['chital_0001', { id: 'chital_0001', speciesId: 'chital', patchId: 0, state: 'resting',
  currentGoal: 'rest', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } }]]);

describe('live agents in the observer', () => {
  it('accepts only well-formed live messages', () => {
    expect(isLiveMessage(message(1, 5))).toBe(true);
    expect(isLiveMessage({ ...message(1, 5), avatars: [{ ...avatar(5), x: 'far' }] })).toBe(false);
    expect(isLiveMessage({ ...message(1, 5), avatars: [{ ...avatar(5), action: 'fly' }] })).toBe(false);
    expect(isLiveMessage({ ...message(1, 5), drops: [{ id: 'd', amountMicro: '1e9', hint: { x: 0, z: 0, radius: 40 }, expiresAt: 0 }] })).toBe(false);
    expect(isLiveMessage({ type: 'scene' })).toBe(false);
    // What an agent said rides along as plain text of bounded length.
    expect(isLiveMessage({ ...message(1, 5), avatars: [avatar(5, { said: 'Water to the east' })] })).toBe(true);
    expect(isLiveMessage({ ...message(1, 5), avatars: [avatar(5, { said: 'x'.repeat(201) })] })).toBe(false);
    expect(isLiveMessage({ ...message(1, 5), avatars: [avatar(5, { said: { html: '<b>' } })] })).toBe(false);
  });

  it('runs at an even pace when the 10 Hz updates arrive unevenly, so a running animal and the camera on it do not shake', () => {
    // A running agent at 8 m/s, sent every 100 ms of server time, arriving up to 45 ms late.
    const live = new LiveAgents(() => 0);
    const late = (i: number) => [0, 45, 5, 30, 0, 40, 10, 0, 25, 45, 0, 15][i % 12]!;
    const sent = Array.from({ length: 40 }, (_, i) => ({ at: 10_000 + i * 100, x: i * 0.8, recv: i * 100 + late(i) }));
    const steps: number[] = [];
    let last: number | null = null, next = 0;
    for (let now = 600; now < 3500; now += 1000 / 60) {
      while (next < sent.length && sent[next]!.recv <= now) { live.apply(message(sent[next]!.at, sent[next]!.x), sent[next]!.recv); next++; }
      const x = live.positions(now).get('chital_0001')!.x;
      if (last !== null) steps.push(x - last);
      last = x;
    }
    // Every frame moves 8 m/s × 1/60 s, within the 5% the delay may ease by; the old drawing jumped ahead or stood still.
    for (const step of steps) expect(Math.abs(step - 0.8 / 6) / (0.8 / 6)).toBeLessThan(0.06);
  });

  it('runs at an even pace at the server\'s own 4 Hz, however late each update arrives', () => {
    // What the server sends: every 250 ms. On the old drawing the animal stood still in 28% of the
    // frames of a real local run while it waited for the next update.
    const live = new LiveAgents(() => 0);
    const late = (i: number) => [0, 60, 10, 90, 0, 30, 70, 0, 20, 80][i % 10]!;
    const sent = Array.from({ length: 30 }, (_, i) => ({ at: 50_000 + i * 250, x: i * 2, recv: i * 250 + late(i) }));
    const steps: number[] = [];
    let last: number | null = null, next = 0;
    for (let now = 2000; now < 6500; now += 1000 / 60) {
      while (next < sent.length && sent[next]!.recv <= now) { live.apply(message(sent[next]!.at, sent[next]!.x), sent[next]!.recv); next++; }
      const x = live.positions(now).get('chital_0001')!.x;
      if (last !== null) steps.push(x - last);
      last = x;
    }
    for (const step of steps) expect(Math.abs(step - 2 / 15) / (2 / 15)).toBeLessThan(0.06);
  });

  it('waits one and a half send intervals plus the arrival spread, within bounds', () => {
    expect(playoutDelay([], [])).toBe(375);
    expect(playoutDelay([250, 250, 251], [-1000, -990, -930])).toBe(375 + 70);
    expect(playoutDelay([100, 100], [5, 5])).toBe(150);
    expect(playoutDelay([2000], [0, 9000])).toBe(1500);
  });

  it('draws an agent between its last two updates, so it glides rather than jumps', () => {
    const live = new LiveAgents(() => 0);
    live.apply(message(1000, 0), 0);
    live.apply(message(1250, 10), 250);
    // 375 ms behind the server (1.5 × 250 ms), halfway between the two updates.
    const halfway = live.positions(500).get('chital_0001')!;
    expect(halfway.x).toBeCloseTo(5);
    expect(live.positions(10_000).get('chital_0001')!.x).toBe(10);
  });

  it('turns an agent into a pose the animal layer draws, running when it runs', () => {
    const live = new LiveAgents(() => 0);
    live.apply({ ...message(1000, 3), avatars: [avatar(3, { gait: 'run' })] }, 0);
    const pose = live.poses(100, animals).get('chital_0001')!;
    expect(pose.animal.state).toBe('travelling');
    expect(pose.hurried).toBe(true);
    live.apply({ ...message(1250, 3), avatars: [avatar(3, { moving: false, action: 'graze' })] }, 250);
    expect(live.poses(600, animals).get('chital_0001')!.animal.state).toBe('grazing');
    expect(live.poses(600, new Map()).size).toBe(0); // Unknown animal: not drawn.
  });

  it('says what an agent is doing in plain words', () => {
    expect(activityOf(avatar(0, { gait: 'trot' }))).toBe('trotting');
    expect(activityOf(avatar(0, { moving: false, action: 'drink' }))).toBe('drinking');
    expect(activityOf(avatar(0, { moving: false, action: 'open' }))).toBe('opening a drop');
    expect(usdc('2500000')).toBe('2.5');
  });

  it('shows a hint circle for a drop, and a beam once spotted, then removes it', () => {
    const live = new LiveAgents(() => 1);
    const drop = { id: 'd1', amountMicro: '1000000', hint: { x: 10, z: 10, radius: 40 }, expiresAt: 0 };
    live.apply(message(1, 0, [drop]), 0);
    const group = live.root.getObjectByName('drop-d1')!;
    expect(group.children[1]!.visible).toBe(false); // Beam hidden until spotted.
    live.apply(message(2, 0, [{ ...drop, spotted: { x: 12, z: 9, by: 'ag_1' } }]), 1);
    expect(group.children[1]!.visible).toBe(true);
    expect(group.children[1]!.position.x).toBe(12);
    live.apply(message(3, 0, []), 2);
    expect(live.root.getObjectByName('drop-d1')).toBeUndefined();
  });

  it('keeps a brief roster of everyone playing, far from the camera or not', () => {
    const roster = { type: 'live-roster', agents: [{ agentId: 'ag_1', name: 'Sora', animalId: 'chital_1', speciesId: 'chital', x: 1, z: 2, activity: 'trot' }] };
    expect(isRosterMessage(roster)).toBe(true);
    expect(isRosterMessage({ ...roster, agents: [{ ...roster.agents[0], x: 'far' }] })).toBe(false);
    const live = new LiveAgents(() => 0);
    live.applyRoster(roster as never);
    expect(live.roster).toHaveLength(1);
    expect(rosterActivity(live.roster[0]!)).toBe('trotting');
    live.clear();
    expect(live.roster).toEqual([]);
  });

  it('draws a wild animal in a live chase off its recording, running', () => {
    const live = new LiveAgents(() => 0);
    const wild = [{ animalId: 'chital_0001', speciesId: 'chital', x: 0, z: 0, heading: 0, mode: 'flee' as const }];
    expect(isLiveMessage({ ...message(1, 0), avatars: [], wild })).toBe(true);
    expect(isLiveMessage({ ...message(1, 0), avatars: [], wild: [{ ...wild[0], mode: 'fly' }] })).toBe(false);
    live.apply({ ...message(1000, 0), avatars: [], wild }, 0);
    const pose = live.poses(10, animals).get('chital_0001')!;
    expect(pose.animal.state).toBe('fleeing');
    expect(pose.hurried).toBe(true);
    live.apply({ ...message(1250, 0), avatars: [], wild: [{ ...wild[0], x: 10, mode: 'stalk' }] }, 250);
    expect(live.poses(500, animals).get('chital_0001')!.position.x).toBeCloseTo(5);
    expect(live.poses(500, animals).get('chital_0001')!.animal.state).toBe('stalking');
    expect(activityOf(avatar(0, { action: 'hunt', gait: 'run' }))).toBe('charging');
  });
});

describe('drops leaving the island', () => {
  it('free the GPU resources each drop owned', () => {
    const live = new LiveAgents(() => 0);
    const drop = { id: 'd1', amountMicro: '1000000', hint: { x: 10, z: 10, radius: 30 }, expiresAt: 0, spotted: { x: 12, z: 11, by: 'a' } };
    live.apply({ type: 'live', at: 1, avatars: [], drops: [drop] }, 0);
    const group = live.root.getObjectByName('drop-d1')!;
    const meshes = group.children as THREE.Mesh[];
    const shared = new Set(meshes.filter((m) => m !== meshes[1] && m !== meshes[3]).flatMap((m) => [m.geometry, m.material]));
    const owned = [meshes[1]!.material as THREE.Material, meshes[3]!.geometry];
    const disposed = new Set<unknown>();
    for (const resource of [...owned, ...shared]) (resource as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed.add(resource));
    live.apply({ type: 'live', at: 2, avatars: [], drops: [] }, 100);
    expect(live.root.getObjectByName('drop-d1')).toBeUndefined();
    for (const resource of owned) expect(disposed.has(resource)).toBe(true);
    // Shared by every drop: kept for the next one.
    for (const resource of shared) expect(disposed.has(resource)).toBe(false);
  });
});
