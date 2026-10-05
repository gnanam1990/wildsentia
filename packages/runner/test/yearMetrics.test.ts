import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { emptySoakYear, recordYearEvent, type ParentLookup } from '../src/yearMetrics.js';

const died = (child: string, cause: string, careState: string, lifeStage = 'newborn',
  position = { x: 0, z: 0 }): WorldEvent => ({
  type: 'died', worldTime: 100, simVersion: 'x', patchId: 4, position, actors: [child],
  conditions: { cause, careState, lifeStage, species: 'boar', ageDays: 5 }, outcome: 'success',
  effects: {}, causalParents: [], confidence: 'authoritative' }) as WorldEvent;

const lookup = (parentAt: { x: number; z: number } | null): ParentLookup => ({
  dependentOn: () => 'boar_mother',
  locate: () => parentAt && { patchId: 5, position: { ...parentAt } },
  careRadiusM: () => 1.1375,
});

describe('per-year soak accounting', () => {
  it('counts births, deaths and deprivation by care state from authoritative events', () => {
    const year = emptySoakYear(1, 0);
    recordYearEvent(year, { type: 'born', conditions: { species: 'boar' } } as unknown as WorldEvent, lookup(null));
    recordYearEvent(year, died('boar_a', 'predation', 'weaned'), lookup(null));
    recordYearEvent(year, died('boar_b', 'dehydration', 'unweaned_without_parent'), lookup(null));
    recordYearEvent(year, died('boar_c', 'starvation', 'weaned', 'juvenile'), lookup(null));
    expect(year.births).toEqual({ boar: 1 });
    expect(year.deaths).toEqual({ boar: 3, 'boar/predation': 1, 'boar/dehydration': 1, 'boar/starvation': 1 });
    expect(year.deathsByCause).toEqual({ predation: 1, dehydration: 1, starvation: 1 });
    expect(year.deprivation).toEqual({ 'boar/dehydration/unweaned_without_parent': 1, 'boar/starvation/weaned': 1 });
    expect(year.weanedYoungDeprivation).toBe(1);
    expect(year.youngDeprivationWithParent).toEqual({ near: 0, remote: 0, unknown: 0 });
  });

  it('separates a living parent in contact from one out of reach', () => {
    const year = emptySoakYear(1, 0);
    const near = recordYearEvent(year, died('boar_n', 'dehydration', 'unweaned_with_parent'), lookup({ x: 1, z: 0 }));
    const remote = recordYearEvent(year, died('boar_r', 'dehydration', 'unweaned_with_parent'), lookup({ x: 300, z: 0 }));
    expect(near).toMatchObject({ contact: 'near', parentId: 'boar_mother', parentDistanceM: 1 });
    expect(remote).toMatchObject({ contact: 'remote', parentDistanceM: 300, parentPatchId: 5 });
    expect(year.youngDeprivationWithParent).toEqual({ near: 1, remote: 1, unknown: 0 });
  });
});
