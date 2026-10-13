import { describe, expect, it } from 'vitest';
import { EventLog } from '../src/events/log.js';
import { THIRST_PER_DAY } from '../src/agents/drives.js';
import { finishCare, type CareVisit } from '../src/agents/family.js';
import { boarMaternalWaterCap, needsOf, provisionYoung } from '../src/agents/needs.js';
import { takeSnapshot, restoreSnapshot } from '../src/snapshot.js';
import { createWorld } from '../src/world.js';
import { makeAgent, speciesOf, SPECIES_DIR } from './helpers.js';
import { ISLAND_GRID } from '@vana/shared';

const boar = speciesOf('boar');
const HOUR = 3600;

function litter() {
  const parent = makeAgent('boar', { id: 'mother', position: { x: 0, z: 0, heading: 0 },
    currentGoal: 'care_for_young', drives: { hunger: 0.1, thirst: 0.1, fatigue: 0, fear: 0 } });
  const child = makeAgent('boar', { id: 'piglet', bornAt: 0, ageDays: 7, lifeStage: 'newborn',
    dependentOn: parent.id, massKg: 9, position: { x: 0.5, z: 0, heading: 0 },
    drives: { hunger: 0.4, thirst: 0.4, fatigue: 0, fear: 0 } });
  parent.offspringIds = [child.id];
  const starts = new Map([[child.id, { patchId: child.patchId, position: { ...child.position! } }]]);
  const log = new EventLog(1, 'test');
  const visit = (from: number, to: number, one = child) => {
    const arrival: CareVisit = { parent, arrival: from, position: { ...parent.position! } };
    finishCare(arrival, [one], starts, boar, from, to, log);
    return log.all().filter(e => e.type === 'provisioned' && e.actors[0] === one.id).at(-1);
  };
  return { parent, child, starts, log, visit };
}

describe('boar maternal hydration arrears', () => {
  it('uses elapsed real care time, not a one-hour full-day catch-up, and debits the parent exactly', () => {
    const s = litter(), daily = needsOf(s.child, boar).waterL;
    const source = needsOf(s.parent, boar).waterL;
    const parentBefore = s.parent.drives.thirst, childBefore = s.child.drives.thirst;
    const first = s.visit(3 * HOUR, 4 * HOUR)!;
    expect(first.effects.waterEquivalentL).toBeCloseTo(daily * 4 / 24);
    expect(s.child.lastMaternalWaterAt).toBe(4 * HOUR);
    expect((s.parent.drives.thirst - parentBefore) * source / THIRST_PER_DAY)
      .toBeCloseTo(Number(first.effects.waterEquivalentL));
    expect((childBefore - s.child.drives.thirst) * daily / THIRST_PER_DAY)
      .toBeCloseTo(Number(first.effects.waterEquivalentL));

    const second = s.visit(7 * HOUR, 8 * HOUR)!;
    expect(second.effects.waterEquivalentL).toBeCloseTo(daily * 4 / 24);
    expect(s.child.lastMaternalWaterAt).toBe(8 * HOUR);

    // A day away cannot be repaid in one contact; the parent may also run out of safe reserves.
    s.parent.drives.thirst = 0;
    const longGap = s.visit(31 * HOUR, 32 * HOUR)!;
    expect(longGap.effects.waterEquivalentL).toBeCloseTo(daily * 8 / 24);
    expect(Number(longGap.effects.waterEquivalentL)).toBeLessThan(daily);
  });

  it('preserves the timestamp over repeated contacts and never transfers water at zero elapsed time', () => {
    const s = litter(), daily = needsOf(s.child, boar).waterL;
    s.visit(3 * HOUR, 4 * HOUR);
    const before = s.child.drives.thirst, parentBefore = s.parent.drives.thirst;
    const repeated = s.visit(3 * HOUR, 4 * HOUR)!;
    expect(repeated.effects.waterEquivalentL).toBe(0);
    expect(s.child.lastMaternalWaterAt).toBe(4 * HOUR);
    expect(s.child.drives.thirst).toBe(before);
    expect(s.parent.drives.thirst).toBe(parentBefore);
    expect(boarMaternalWaterCap(s.child, boar, 1, 4 * HOUR, daily)).toBe(0);
    expect(boarMaternalWaterCap(s.child, boar, 1, 4 * HOUR - 1, daily)).toBe(0);
  });

  it('does not reset maternal arrears at a world-day boundary', () => {
    const s = litter(), daily = needsOf(s.child, boar).waterL;
    s.visit(22 * HOUR, 23 * HOUR);
    s.parent.drives.thirst = 0;
    const nextDay = s.visit(24 * HOUR, 25 * HOUR)!;
    expect(nextDay.effects.waterEquivalentL).toBeCloseTo(daily * 2 / 24);
    expect(s.child.lastMaternalWaterAt).toBe(25 * HOUR);
  });

  it('rejects almost-arrived touches and invalid times without a water transfer or timestamp change', () => {
    const s = litter(), daily = needsOf(s.child, boar).waterL;
    const short = s.visit(4 * HOUR - 59, 4 * HOUR)!;
    expect(short.effects.waterEquivalentL).toBe(0);
    expect(s.child.lastMaternalWaterAt).toBeUndefined();
    for (const at of [undefined, NaN, Infinity])
      expect(boarMaternalWaterCap(s.child, boar, 1, at, daily)).toBe(0);
    expect(boarMaternalWaterCap(s.child, boar, 59 / 3600, 4 * HOUR, daily)).toBe(0);
  });

  it('requires living close family and real donor reserves; food and other species keep their old cap', () => {
    const s = litter();
    s.parent.drives.thirst = 0.8;
    expect(s.visit(3 * HOUR, 4 * HOUR)!.effects.waterEquivalentL).toBe(0);
    expect(s.child.lastMaternalWaterAt).toBeUndefined();
    s.parent.drives.thirst = 0.1;
    s.parent.position!.x = 10;
    const before = s.log.all().length;
    s.visit(5 * HOUR, 6 * HOUR);
    expect(s.log.all()).toHaveLength(before);
    s.parent.position!.x = 0;
    s.parent.alive = false;
    s.visit(7 * HOUR, 8 * HOUR);
    expect(s.log.all()).toHaveLength(before);

    const other = speciesOf('dhole');
    const donor = makeAgent('dhole', { id: 'dhole_mother', position: { x: 0, z: 0, heading: 0 },
      drives: { hunger: 0.1, thirst: 0.1, fatigue: 0, fear: 0 } });
    const pup = makeAgent('dhole', { id: 'dhole_pup', dependentOn: donor.id, ageDays: 7,
      position: { x: 0, z: 0, heading: 0 }, drives: { hunger: 0.4, thirst: 0.4, fatigue: 0, fear: 0 } });
    const unchanged = provisionYoung(ISLAND_GRID, donor, pup, other, 1, undefined, 4 * HOUR);
    expect(unchanged.foodEquivalentKg).toBeCloseTo(needsOf(pup, other).foodKg / 8);
    expect(unchanged.waterEquivalentL).toBeCloseTo(needsOf(pup, other).waterL / 8);
    expect(pup.lastMaternalWaterAt).toBeUndefined();
  });

  it('leaves boar day-ten care on the prior generic cap', () => {
    const s = litter(); s.child.ageDays = 10;
    const care = s.visit(3 * HOUR, 4 * HOUR)!;
    expect(care.effects.waterEquivalentL).toBeCloseTo(needsOf(s.child, boar).waterL / 8);
    expect(s.child.lastMaternalWaterAt).toBeUndefined();
  });

  it('covers seven real spaced contacts in a day without accumulating synthetic thirst', () => {
    const s = litter(), daily = needsOf(s.child, boar).waterL;
    s.child.drives.thirst = 0.2;
    s.parent.drives.thirst = 0;
    let previousHour = 0, transferred = 0;
    for (const hour of [3, 6, 9, 12, 16, 20, 24]) {
      s.child.drives.thirst += THIRST_PER_DAY * (hour - previousHour) / 24;
      const event = s.visit((hour - 1) * HOUR, hour * HOUR)!;
      transferred += Number(event.effects.waterEquivalentL);
      previousHour = hour;
    }
    expect(transferred).toBeCloseTo(daily);
    expect(s.child.drives.thirst).toBeCloseTo(0.2);
    expect(s.parent.drives.thirst).toBeCloseTo(daily / needsOf(s.parent, boar).waterL * THIRST_PER_DAY);
    expect(s.log.all().filter(e => e.type === 'provisioned')).toHaveLength(7);
  });

  it('persists the contact clock through an authoritative snapshot and deterministic restart', () => {
    const options = { seed: 41, speciesDir: SPECIES_DIR, initialAgents: { boar: 1 }, minPopulation: {} };
    const world = createWorld(options), child = world.agents[0]!;
    child.lastMaternalWaterAt = world.now();
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(world))), options);
    expect(restored.agents[0]!.lastMaternalWaterAt).toBe(world.now());
    world.log.take();
    for (let i = 0; i < 24; i++) { world.step(1); restored.step(1); }
    expect(restored.agents).toEqual(world.agents);
    expect(restored.log.all()).toEqual(world.log.all());
  });
});
