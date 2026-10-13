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
