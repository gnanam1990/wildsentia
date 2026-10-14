import { describe, expect, it } from 'vitest';
import { BountyDiscovery, motionOf } from '../src/bounties/discovery.js';

const bounty = { bountyId: 'b1', targetAnimalId: 'blue_duiker_0001', amountAtomic: 10_000_000n, decimals: 6, deadlineWorldTime: 90_000 };

// Congo 1D (spec §6): an agent learns a bounty's target only when its animal perceives it.
describe('bounty discovery', () => {
  const setup = () => {
    const entrants: string[] = [];
    const discovery = new BountyDiscovery({ active: async () => [bounty], recordEntrant: async (b, agent, animal) => { entrants.push(`${b}:${agent}:${animal}`); return true; } }, () => 'w1');
    return { discovery, entrants };
  };
  const leopard = { animalId: 'african_leopard_0002', speciesId: 'african_leopard', x: 0, z: 0 };
  const noon = 12 * 3600;
  const open = { canopyAt: () => 0, worldTime: noon };

  it('flags a perceived target with its amount and time left, and lists only what is sensed', async () => {
    const { discovery, entrants } = setup();
    await discovery.refresh();
    const seen = discovery.view('ag_1', leopard, [
      { id: 'blue_duiker_0001', x: 0, z: 100, moving: false, running: false },
      { id: 'blue_duiker_0009', x: 0, z: 120, moving: false, running: false },
      { id: 'water_chevrotain_0003', x: 0, z: 190, moving: false, running: false },
    ], open);
    expect(seen.nearby.map((a) => a.id)).toEqual(['blue_duiker_0001', 'blue_duiker_0009']);
    expect(seen.nearby[0]).toMatchObject({ sense: 'sight', bounty: { bountyId: 'b1', amountAtomic: '10000000', decimals: 6, timeLeftWorldSeconds: 90_000 - noon } });
    expect(seen.nearby[1]!.bounty).toBeUndefined();
    await discovery.idle();
    expect(entrants).toEqual(['b1:ag_1:african_leopard_0002']);
  });

  it('keeps only the last-seen position of a target once it is no longer sensed, and never one never sensed', async () => {
    const { discovery } = setup();
    await discovery.refresh();
    expect(discovery.view('ag_2', leopard, [{ id: 'blue_duiker_0001', x: 0, z: 400, moving: false, running: false }], open).lastSeen).toEqual([]);
    discovery.view('ag_1', leopard, [{ id: 'blue_duiker_0001', x: 10, z: 100, moving: false, running: false }], open);
    const later = discovery.view('ag_1', leopard, [{ id: 'blue_duiker_0001', x: 10, z: 100, moving: false, running: false }], { canopyAt: () => 0.95, worldTime: noon + 60 });
    expect(later.nearby).toEqual([]);
    expect(later.lastSeen).toEqual([{ bountyId: 'b1', x: 10, z: 100, worldTime: noon, amountAtomic: '10000000', decimals: 6, timeLeftWorldSeconds: 90_000 - noon - 60 }]);
  });
  it('hears an animal an agent is steering by how it moves now, not by the sim\'s last state', () => {
    expect(motionOf({ state: 'resting' }, null, { moving: true, gait: 'run' })).toEqual({ moving: true, running: true });
    expect(motionOf({ state: 'resting' }, null, { moving: false, gait: 'walk' })).toEqual({ moving: false, running: false });
    expect(motionOf({ state: 'travelling' }, null, null)).toEqual({ moving: true, running: false });
    expect(motionOf({ state: 'resting' }, { mode: 'flee' }, null)).toEqual({ moving: true, running: true });
  });
  it('puts a sensed bounty target first, so a crowd never pushes it out of the list', async () => {
    const { discovery } = setup();
    await discovery.refresh();
    const crowd = Array.from({ length: 40 }, (_, i) => ({ id: `blue_duiker_${100 + i}`, x: 0, z: 5 + i, moving: false, running: false }));
    const seen = discovery.view('ag_9', leopard, [...crowd, { id: 'blue_duiker_0001', x: 0, z: 90, moving: false, running: false }], open);
    expect(seen.nearby[0]!.id).toBe('blue_duiker_0001');
  });
});

// Spec §6 Clues: only real activity, from a sampled track log of each active bounty's target —
// fresh tracks near the agent's animal, calls it can hear, disturbance in the patch it stands in.
// A clue names the bounty and species, never the animal.
describe('bounty clues', () => {
  const duiker = { ...bounty, speciesId: 'blue_duiker' };
  const setup = (active = [duiker]) => {
    let live = active;
    const discovery = new BountyDiscovery({ active: async () => live, recordEntrant: async () => true }, () => 'w1');
    return { discovery, end: () => { live = []; } };
  };
  const leopard = { animalId: 'african_leopard_0002', speciesId: 'african_leopard', x: 0, z: 0 };
  const noon = 12 * 3600;
  const at = (worldTime: number, patch = (x: number, z: number) => Math.floor(x / 50) * 1000 + Math.floor(z / 50)) =>
    ({ canopyAt: () => 0.9, worldTime, patchIdAt: patch });
  // The target's real path: walking north along x = 20 an hour before noon, out of sense by noon.
  const walk = (discovery: BountyDiscovery, state = 'travelling', from = noon - 3600) => {
    for (let i = 0; i <= 12; i++) {
      const t = from + i * 60;
      discovery.sample((id) => (id === 'blue_duiker_0001' ? { x: 20, z: -60 + i * 10, state } : null), t);
    }
  };

  it('finds fresh tracks near the animal: where, how old and which way the target went, never which animal', async () => {
    const { discovery } = setup();
    await discovery.refresh();
    walk(discovery);
    const seen = discovery.view('ag_1', leopard, [], at(noon));
    const tracks = seen.clues.filter((c) => c.kind === 'tracks');
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ kind: 'tracks', bountyId: 'b1', speciesId: 'blue_duiker', x: 20 });
    expect(Math.hypot(tracks[0]!.x!, tracks[0]!.z!)).toBeLessThanOrEqual(30);
    expect(tracks[0]!.ageWorldSeconds).toBeGreaterThanOrEqual(3600 - 12 * 60);
    expect(tracks[0]!.headingDeg).toBe(0); // north: +z
    expect(JSON.stringify(seen.clues)).not.toContain('blue_duiker_0001');
  });

  it('lets tracks fade: none older than four world hours, none far from the animal', async () => {
    const { discovery } = setup();
    await discovery.refresh();
    walk(discovery, 'travelling', noon - 5 * 3600);
    expect(discovery.view('ag_1', leopard, [], at(noon)).clues.filter((c) => c.kind === 'tracks')).toEqual([]);
    walk(discovery);
    expect(discovery.view('ag_1', { ...leopard, x: 300, z: 300 }, [], at(noon)).clues.filter((c) => c.kind === 'tracks')).toEqual([]);
  });

  it('hears a call (a fleeing target\'s alarm) as a bearing and a rough distance, only while it is recent and within earshot', async () => {
    const { discovery } = setup();
    await discovery.refresh();
    discovery.sample((id) => (id === 'blue_duiker_0001' ? { x: 200, z: 0, state: 'fleeing' } : null), noon - 300);
    const call = discovery.view('ag_1', leopard, [], at(noon)).clues.find((c) => c.kind === 'call');
    expect(call).toMatchObject({ kind: 'call', bountyId: 'b1', speciesId: 'blue_duiker', bearingDeg: 90, distance: 'far' });
    expect(call!.x).toBeUndefined();
    expect(discovery.view('ag_1', leopard, [], at(noon + 3600)).clues.find((c) => c.kind === 'call')).toBeUndefined();
    expect(discovery.view('ag_1', { ...leopard, x: -500 }, [], at(noon)).clues.find((c) => c.kind === 'call')).toBeUndefined();
  });

  it('notices disturbance in the patch the animal stands in when the target crossed it lately', async () => {
    const { discovery } = setup();
    await discovery.refresh();
    walk(discovery);
    const here = discovery.view('ag_1', { ...leopard, x: 30, z: 10 }, [], at(noon)).clues.find((c) => c.kind === 'disturbance');
    expect(here).toMatchObject({ kind: 'disturbance', bountyId: 'b1', speciesId: 'blue_duiker' });
    expect(discovery.view('ag_1', { ...leopard, x: 400, z: 400 }, [], at(noon)).clues.find((c) => c.kind === 'disturbance')).toBeUndefined();
  });

  it('gives no clue for a target it senses now (that is flagged), and forgets a bounty that ends', async () => {
    const { discovery, end } = setup();
    await discovery.refresh();
    walk(discovery);
    const sensing = discovery.view('ag_1', leopard, [{ id: 'blue_duiker_0001', x: 20, z: 60, moving: true, running: false }], { ...at(noon), canopyAt: () => 0 });
    expect(sensing.nearby[0]!.bounty).toBeDefined();
    expect(sensing.clues).toEqual([]);
    end();
    await discovery.refresh();
    expect(discovery.view('ag_2', leopard, [], at(noon)).clues).toEqual([]);
  });
});
