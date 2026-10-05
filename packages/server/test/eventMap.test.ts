import { describe, expect, it } from 'vitest';
import { eventMarker } from '../src/eventMap.js';
import { patchCentre, type WorldEvent } from '@vana/shared';
const base: WorldEvent = { id: 'event-1', type: 'born', worldTime: 3600, simVersion: 'test', patchId: 1,
  actors: ['child', 'mother'], conditions: {}, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative' };
describe('event map provenance', () => {
  it('uses saved birth/death coordinates independently of any living animal or remaining carcass', () => {
    const position = { x: 317.125, z: -10.5, heading: 1.2 };
    for (const type of ['born', 'died'] as const)
      expect(eventMarker({ ...base, type, position })).toMatchObject({ precision: 'recorded', position: { x: 317.125, z: -10.5 } });
    expect(eventMarker({ ...base, position: { ...position, x: NaN } })?.precision).toBe('patch');
    expect(eventMarker({ ...base, position: { ...position, z: 1000 } })?.precision).toBe('patch');
  });
  it('uses approximate historical patch positions for births and deaths, not current actor positions', () => {
    expect(eventMarker(base)).toMatchObject({ actorId: 'child', precision: 'patch', position: patchCentre(1) });
    expect(eventMarker({ ...base, type: 'died' })).toMatchObject({ label: 'Death', precision: 'patch' });
    expect(eventMarker({ ...base, type: 'fed' })).toBeNull();
    expect(eventMarker({ ...base, patchId: -1 })).toBeNull();
  });
  it('maps a recorded island arrival at its shore position, labelled as a crossing (sim_0.33.0)', () => {
    const event: WorldEvent = { ...base, type: 'immigration', actors: ['tiger_0f00'],
      position: { x: 317.125, z: -10.5, heading: 0 }, conditions: { species: 'tiger', route: 'island_crossing', trigger: 'small_population' } };
    expect(eventMarker(event)).toMatchObject({ type: 'immigration', actorId: 'tiger_0f00', label: 'Arrived across the water',
      precision: 'recorded', position: { x: 317.125, z: -10.5 } });
    expect(eventMarker({ ...event, conditions: { species: 'chital' } })?.label).toBe('Arrival');
  });
  it('points a recorded human birth marker at the persistent child person, not a parent or an animal', () => {
    const event: WorldEvent = { ...base, type: 'human_born', actors: ['person_0005', 'person_0001', 'person_0002', 'village_0001'],
      position: { x: 317.125, z: -10.5, heading: 1.2 }, conditions: { childId: 'person_0005' } };
    expect(eventMarker(event)).toMatchObject({ type: 'human_born', actorId: 'person_0005', label: 'Human birth',
      precision: 'recorded', position: { x: 317.125, z: -10.5 } });
  });
  it('points a recorded human death marker at the deceased person', () => {
    const event: WorldEvent = { ...base, type: 'human_died', actors: ['person_0005', 'village_0001', 'home_0001'],
      position: { x: 317.125, z: -10.5, heading: 1.2 }, conditions: { cause: 'aging' } };
    expect(eventMarker(event)).toMatchObject({ type: 'human_died', actorId: 'person_0005', label: 'Human death',
      precision: 'recorded', position: { x: 317.125, z: -10.5 } });
  });
  it('uses the recorded hunt endpoint when valid, falling back honestly when absent or mismatched', () => {
    const hunt: WorldEvent = { ...base, type: 'hunt', encounter: { version: 1, predatorId: 'tiger', preyId: 'deer', startWorldTime: 0,
      patchId: 1, contactRadiusM: 1, samples: [{ seconds: 1, phase: 'escape', predator: { x: 300, z: 0, heading: 0 }, prey: { x: 301, z: 0, heading: 0 } }] } };
    expect(eventMarker(hunt)).toMatchObject({ precision: 'recorded', position: { x: 301, z: 0 } });
    expect(eventMarker({ ...hunt, patchId: 20 })?.precision).toBe('patch');
  });
  it('maps human hunt attempts at recorded contact, linking the prey without offering an animal-attack replay', () => {
    const marker = eventMarker({ ...base, type: 'human_hunt', actors: ['person_0001', 'village_0001'],
      conditions: { preyId: 'hare_0012', preySpecies: 'hare' }, outcome: 'success',
      position: { x: 317, z: 2, heading: 0 } });
    expect(marker).toMatchObject({ type: 'human_hunt', actorId: 'hare_0012', actors: ['person_0001', 'village_0001'],
      label: 'Human hunt / catch', precision: 'recorded', position: { x: 317, z: 2 } });
  });
});
