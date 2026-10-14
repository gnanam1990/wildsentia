import { describe, expect, it } from 'vitest';
import { bountyLife, isBountyRecord } from '../src/bountyReplay.js';

// Congo spec §5 Records and replay: the forest viewer replays a decided bounty from its record —
// the target's path over the bounty and the events that decided it.
const record = (outcome: string, extra: Record<string, unknown> = {}) => ({
  simulated: true, bountyId: '0b5c3e0e-5f8a-4c51-9d77-1d6f0f0c2a11', outcome, targetAnimalId: 'blue_duiker_0001', targetSpeciesId: 'blue_duiker',
  winnerAnimalId: outcome === 'predator' ? 'african_leopard_0002' : null, decidedWorldTime: 4_000, rulesHash: 'h', payout: null, entrants: 1,
  record: {
    sha256: 'a'.repeat(64),
    events: [{ id: 'e9', type: 'hunt', worldTime: 3_990, outcome: 'success', actors: ['african_leopard_0002', 'blue_duiker_0001'], position: { x: 14, z: 22, heading: 0 } },
      { id: 'e10', type: 'died', worldTime: 3_990, outcome: 'predation', actors: ['blue_duiker_0001'] }],
    track: [{ x: 0, z: 0, state: 'grazing', worldTime: 1_000.4 }, { x: 0, z: 10, state: 'travelling', worldTime: 1_000.6 },
      { x: 0, z: 20, state: 'travelling', worldTime: 2_000 }, { x: 10, z: 20, state: 'fleeing', worldTime: 3_980 }],
  }, ...extra,
});
const patchOf = (x: number, z: number) => Math.floor(x / 50) * 100 + Math.floor(z / 50);

describe('bounty replay', () => {
  it('accepts a settled bounty\'s record and refuses anything malformed', () => {
    expect(isBountyRecord(record('predator'))).toBe(true);
    expect(isBountyRecord({ ...record('predator'), record: null })).toBe(false);
    expect(isBountyRecord({ ...record('predator'), targetAnimalId: '' })).toBe(false);
    expect(isBountyRecord({ ...record('predator'), record: { ...record('predator').record, track: [{ x: 'a' }] } })).toBe(false);
  });

  it('turns the target\'s path into a replayable life: whole, increasing world times, its patch and heading, the kill as its end', () => {
    const life = bountyLife(record('predator') as never, patchOf);
    expect(life).toMatchObject({ id: 'blue_duiker_0001', speciesId: 'blue_duiker', alive: false, bornAt: 1_000, departedAt: 4_000 });
    // 1,000.4 and 1,000.6 are one second; the path runs on to the decision, ending where the kill was.
    expect(life.track.map((p) => p.worldTime)).toEqual([1_000, 2_000, 3_980, 4_000]);
    expect(life.track.at(-1)!.position).toMatchObject({ x: 14, z: 22 });
    expect(life.track.map((p) => p.state)).toEqual(['grazing', 'travelling', 'fleeing', 'fleeing']);
    expect(life.track[1]).toMatchObject({ patchId: 0, position: { x: 0, z: 20 } });
    expect(life.track[2]!.position!.heading).toBeCloseTo(Math.PI / 2, 5); // moved toward +x
    expect(life.moments.map((m) => m.text)).toEqual(['Caught by an African leopard: the bounty went to the hunter', 'Died']);
  });

  it('ends a survival with the deadline reached, the animal still alive', () => {
    const life = bountyLife(record('survival', { record: { ...record('survival').record, events: [] } }) as never, patchOf);
    expect(life).toMatchObject({ alive: true, departedAt: null });
    expect(life.moments).toEqual([{ eventId: 'bounty:0b5c3e0e-5f8a-4c51-9d77-1d6f0f0c2a11:end', worldTime: 4_000, text: 'Alive at the deadline: the bounty went to its owner' }]);
  });
});
