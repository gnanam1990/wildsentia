import { describe, expect, it } from 'vitest';
import { createRng } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { perceive } from '../src/agents/perception.js';
import { activityAt, selectGoal } from '../src/agents/goals.js';
import { makeAgent, makeView, speciesOf } from './helpers.js';

const patches = buildGrid(4);
const at = (hour: number, day = 10) => day * 86400 + hour * 3600 + 600;
const daylight = (hourly: number[]) => hourly.slice(6, 18).reduce((a, b) => a + b, 0) / hourly.reduce((a, b) => a + b, 0);

describe('daily activity cycles (sim_0.37.0)', () => {
  it('follows the field curves: dholes by day, tigers and leopards at dawn, dusk and night', () => {
    const dhole = speciesOf('dhole'), tiger = speciesOf('tiger'), leopard = speciesOf('leopard');
    // Dholes: about three-quarters of activity in daylight (74.4%, Sawaguri et al. 2026), peaks at
    // 06-08 and 17:00, little at night (Andheria et al. 2007: almost totally diurnal hunters).
    expect(daylight(dhole.activity!.hourly)).toBeGreaterThan(0.65);
    expect(daylight(dhole.activity!.hourly)).toBeLessThan(0.8);
    expect(activityAt(dhole, at(7))).toBe(1);
    expect(activityAt(dhole, at(21))).toBeLessThanOrEqual(0.1);
    // Tigers and leopards: bimodal, peaks about 06:00 and 19:00-20:00 (Chatterjee et al. 2023).
    for (const cat of [tiger, leopard]) {
      expect(activityAt(cat, at(6))).toBe(1);
      expect(activityAt(cat, at(19))).toBe(1);
      expect(daylight(cat.activity!.hourly)).toBeLessThan(0.45);
    }
    // Leopards are more active than tigers by day (Andheria et al. 2007; Ramesh et al. 2012).
    expect(activityAt(leopard, at(12))).toBeGreaterThan(activityAt(tiger, at(12)));
    // Species without a curve, and a missing clock, are active at every hour.
    expect(activityAt(speciesOf('chital'), at(3))).toBe(1);
    expect(activityAt(dhole, undefined)).toBe(1);
  });

  it('a hungry dhole hunts in the morning, rests at night, and hunts at night only when starving', () => {
    const dhole = speciesOf('dhole');
    const goalAt = (hour: number, hunger: number) => {
      const hunter = makeAgent('dhole', { id: 'd1', patchId: 10, drives: { hunger, thirst: 0.05, fatigue: 0, fear: 0 } });
      const herd = [0, 1, 2].map(i => makeAgent('chital', { id: `c${i}`, patchId: 10 }));
      const percept = perceive(hunter, dhole, makeView(patches, [hunter, ...herd]));
      return selectGoal(hunter, dhole, percept, createRng(3, 'activity'), 0, at(hour)).goal;
    };
    expect(goalAt(7, 0.5)).toBe('hunt');
    expect(goalAt(21, 0.5)).toBe('rest');
    expect(goalAt(2, 0.5)).toBe('rest');
    expect(goalAt(21, 0.85)).toBe('hunt');
  });

  it('rejects a curve that is not 24 hours peaking at 1', async () => {
    const { SpeciesConfigSchema } = await import('../src/config/loader.js');
    const base = speciesOf('dhole');
    expect(SpeciesConfigSchema.safeParse({ ...base, activity: { hourly: [1, 0.5] } }).success).toBe(false);
    expect(SpeciesConfigSchema.safeParse({ ...base, activity: { hourly: new Array(24).fill(0.5) } }).success).toBe(false);
    expect(SpeciesConfigSchema.safeParse(base).success).toBe(true);
  });
});
