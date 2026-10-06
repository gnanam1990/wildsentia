import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { recordHunt, type HuntMetrics } from '../src/huntMetrics.js';

const event: WorldEvent = {
  id: 'h1', type: 'hunt', worldTime: 10, simVersion: 'test', patchId: 0,
  actors: ['arbitrary-id', 'another-id'], goal: 'hunt',
  conditions: { predatorSpecies: 'dhole', preySpecies: 'sambar', stage: 'escaped', durationSeconds: 10 },
  outcome: 'failure', effects: {}, causalParents: [], confidence: 'authoritative',
  encounter: { version: 1, predatorId: 'arbitrary-id', preyId: 'another-id', patchId: 0,
    startWorldTime: 0, contactRadiusM: 1, samples: [{ seconds: 10, phase: 'contact',
      predator: { x: 0, z: 0, heading: 0 }, prey: { x: 1, z: 0, heading: 0 } }] },
};

describe('hunt evidence', () => {
  it('separates contact from a successful kill and counts species without parsing actor IDs', () => {
    const metrics: Record<string, HuntMetrics> = {};
    recordHunt(metrics, event);
    recordHunt(metrics, { ...event, outcome: 'success', conditions: { ...event.conditions, stage: 'killed' } });
    expect(metrics.dhole).toEqual({ attempts: 2, kills: 1, contacts: 2,
      stages: { escaped: 1, killed: 1 }, prey: { sambar: 2 }, killsByPrey: { sambar: 1 }, packHunts: 0, packKills: 0, seconds: 20 });
    recordHunt(metrics, { ...event, outcome: 'success', conditions: { ...event.conditions, stage: 'killed', packHunters: 3 } });
    expect(metrics.dhole).toMatchObject({ kills: 2, packHunts: 1, packKills: 1, killsByPrey: { sambar: 2 } });
  });
  it('does not invent contact or species evidence for legacy events', () => {
    const metrics: Record<string, HuntMetrics> = {};
    const { encounter: _trace, ...legacy } = event;
    recordHunt(metrics, { ...legacy, conditions: {} });
    recordHunt(metrics, { ...event, type: 'died' });
    expect(metrics).toEqual({ unknown: { attempts: 1, kills: 0, contacts: 0,
      stages: { unknown: 1 }, prey: { unknown: 1 }, killsByPrey: {}, packHunts: 0, packKills: 0, seconds: 0 } });
  });
});
