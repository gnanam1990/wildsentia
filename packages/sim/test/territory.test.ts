import { describe, expect, it } from 'vitest';
import { GRID_SIZE } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { isFloater, territoryRadiusPatches } from '../src/agents/territory.js';
import { makeAgent, speciesOf } from './helpers.js';

const patches = buildGrid(4);
const tiger = speciesOf('tiger');
const chital = speciesOf('chital');
const dhole = speciesOf('dhole');
const at = (x: number, y: number): number => y * GRID_SIZE + x;

describe('territory size', () => {
  it('turns square kilometres into a patch radius that covers about that area', () => {
    // Patches are 300 m across, so twenty square kilometres is about 222 of them, which a
    // diamond of radius ten covers.
    expect(territoryRadiusPatches(20)).toBe(10);
    expect(territoryRadiusPatches(60)).toBeGreaterThan(territoryRadiusPatches(20));
  });
});

describe('isFloater', () => {
  it('gives the territory to the older of two tigresses in the same range', () => {
    const resident = makeAgent('tiger', { id: 'old', sex: 'female', ageDays: 3000, patchId: at(5, 5) });
    const young = makeAgent('tiger', { id: 'young', sex: 'female', ageDays: 1400, patchId: at(7, 6) });
    const rivals = [resident, young];
    expect(isFloater(resident, tiger, rivals, patches)).toBe(false);
    expect(isFloater(young, tiger, rivals, patches)).toBe(true);
  });

  it('lets two tigresses far enough apart each hold a range', () => {
    const west = makeAgent('tiger', { id: 'w', sex: 'female', ageDays: 3000, patchId: at(0, 0) });
    const east = makeAgent('tiger', { id: 'e', sex: 'female', ageDays: 1400, patchId: at(19, 19) });
    expect(isFloater(east, tiger, [west, east], patches)).toBe(false);
  });

  it('does not set a tigress against a tiger: ranges are held against the same sex', () => {
    const male = makeAgent('tiger', { id: 'm', sex: 'male', ageDays: 3000, patchId: at(5, 5) });
    const female = makeAgent('tiger', { id: 'f', sex: 'female', ageDays: 1400, patchId: at(5, 5) });
    expect(isFloater(female, tiger, [male, female], patches)).toBe(false);
  });

  it('never makes a cub still with its mother a floater, nor counts it as a rival', () => {
    const mother = makeAgent('tiger', { id: 'mum', sex: 'female', ageDays: 2000, patchId: at(5, 5) });
    const cub = makeAgent('tiger', {
      id: 'cub', sex: 'female', ageDays: 200, lifeStage: 'juvenile', dependentOn: 'mum', patchId: at(5, 5),
    });
    expect(isFloater(cub, tiger, [mother, cub], patches)).toBe(false);
    expect(isFloater(mother, tiger, [mother, cub], patches)).toBe(false);
  });

  it('does nothing for a species without territories', () => {
    const a = makeAgent('chital', { id: 'a', ageDays: 3000 });
    const b = makeAgent('chital', { id: 'b', ageDays: 900 });
    expect(isFloater(b, chital, [a, b], patches)).toBe(false);
  });
});


describe('isFloater in a pack', () => {
  const pack = (n: number, groupId: string, prefix: string, oldest: number, patchId: number) =>
    Array.from({ length: n }, (_, i) => makeAgent('dhole', {
      id: `${prefix}${i}`, groupId, sex: i % 2 === 0 ? 'female' : 'male',
      ageDays: oldest - i * 100, patchId,
    }));

  it('pushes the youngest out of a pack grown past its size', () => {
    // Young dholes leave their natal pack; with no range free to settle, most die. Without this
    // a pack only ever grew, to thirty and more.
    const max = dhole.social.groupSize[1];
    const members = pack(max + 2, 'g1', 'd', 3000, at(5, 5));
    expect(isFloater(members[0]!, dhole, members, patches)).toBe(false);
    expect(isFloater(members[max - 1]!, dhole, members, patches)).toBe(false);
    expect(isFloater(members[max]!, dhole, members, patches)).toBe(true);
    expect(isFloater(members[max + 1]!, dhole, members, patches)).toBe(true);
  });

  it('does not count pups still with their mothers against the pack size', () => {
    const adults = pack(dhole.social.groupSize[1], 'g1', 'd', 3000, at(5, 5));
    const pups = Array.from({ length: 6 }, (_, i) => makeAgent('dhole', {
      id: `p${i}`, groupId: 'g1', ageDays: 20, lifeStage: 'newborn', dependentOn: 'd0', patchId: at(5, 5),
    }));
    const all = [...adults, ...pups];
    for (const member of adults) expect(isFloater(member, dhole, all, patches)).toBe(false);
  });

  it('leaves the range to the pack with the older leader when two packs overlap', () => {
    // A pack ranges over some forty square kilometres, more than this whole forest, so a
    // second pack inside it is trespassing, however small either pack is.
    const resident = pack(4, 'g1', 'a', 3000, at(5, 5));
    const newcomer = pack(4, 'g2', 'b', 2000, at(9, 8));
    const all = [...resident, ...newcomer];
    for (const member of resident) expect(isFloater(member, dhole, all, patches)).toBe(false);
    for (const member of newcomer) expect(isFloater(member, dhole, all, patches)).toBe(true);
  });
});
