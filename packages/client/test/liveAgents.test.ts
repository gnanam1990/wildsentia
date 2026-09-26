import { describe, expect, it } from 'vitest';
import { LiveAgents, activityOf, isLiveMessage, isRosterMessage, rosterActivity, usdc, type LiveMessage } from '../src/liveAgents.js';
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
  });

  it('draws an agent between its last two updates, so it glides rather than jumps', () => {
    const live = new LiveAgents(() => 0);
    live.apply(message(1000, 0), 0);
    live.apply(message(1250, 10), 250);
    const halfway = live.positions(375).get('chital_0001')!;
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
    expect(live.poses(375, animals).get('chital_0001')!.position.x).toBeCloseTo(5);
    expect(live.poses(375, animals).get('chital_0001')!.animal.state).toBe('stalking');
    expect(activityOf(avatar(0, { action: 'hunt', gait: 'run' }))).toBe('charging');
  });
});
