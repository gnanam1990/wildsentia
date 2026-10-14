import { afterEach, describe, expect, it } from 'vitest';
import { CONGO_GRID, ISLAND_GRID, congoChannelHalfM, congoRivers, riverIndex } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { congoLattice } from '../src/terrain.js';
import { congoWaterSurface } from '../src/congoWater.js';
import { swimBaseY } from '../src/space.js';
import { swimmingClip } from '../src/animation.js';

afterEach(() => setWorldGrid(ISLAND_GRID));

// The island's animals keep to dry land; the Congo's cross rivers and wade the flood. Deeper
// than an animal stands at the hip, it swims: back at the waterline, head above, not walking the bed.
describe('swimming in the Congo forest', () => {
  it('wades shallow water on its feet and swims deep water at the surface', () => {
    expect(swimBaseY(10, null, 0.4)).toEqual({ y: 10, swimming: false });
    expect(swimBaseY(10, 10.2, 0.4)).toEqual({ y: 10, swimming: false });
    expect(swimBaseY(10, 11.5, 0.4)).toEqual({ y: 11.1, swimming: true });
  });
  it('finds the river surface over a channel, the flood only in a flooding season, and nothing on dry ground', () => {
    setWorldGrid(CONGO_GRID);
    const rivers = congoRivers(7, CONGO_GRID), main = rivers[0]!, near = riverIndex(rivers), ground = congoLattice(7).sample;
    const mid = main.points[Math.floor(main.points.length / 2)]!;
    const dry = congoWaterSurface(7, false), wet = congoWaterSurface(7, true);
    const river = dry(mid.x, mid.z);
    expect(river).not.toBeNull();
    expect(river! - ground(mid.x, mid.z)).toBeGreaterThan(0.5);
    // Into the flood belt beside the channel.
    const half = congoChannelHalfM(main, CONGO_GRID);
    let belt: { x: number; z: number } | null = null;
    for (let d = half + 20; d < half + main.floodBeltM && !belt; d += 20) {
      const x = mid.x, z = mid.z + d, at = near(x, z);
      if (at.distanceM > congoChannelHalfM(at.river, CONGO_GRID) + 5) belt = { x, z };
    }
    expect(belt).not.toBeNull();
    expect(dry(belt!.x, belt!.z)).toBeNull();
    expect(wet(belt!.x, belt!.z)! - ground(belt!.x, belt!.z)).toBeCloseTo(0.6, 1);
    expect(wet(mid.x, mid.z + main.floodBeltM + half + 2000)).toBeNull();
  });

  it('plays a swimmer\'s own swim clip in deep water, and its usual clips on land or in death', () => {
    const croc = ['Idle', 'Walk', 'Swim', 'Eating', 'Death'];
    expect(swimmingClip(true, 'travelling', croc)).toBe('Swim');
    expect(swimmingClip(true, 'resting', croc)).toBe('Swim');
    expect(swimmingClip(false, 'travelling', croc)).toBeNull();
    expect(swimmingClip(true, 'dead', croc)).toBeNull();
    // An animal with no swim clip paddles its walk (slowed, in animals.ts).
    expect(swimmingClip(true, 'travelling', ['Idle', 'Walk'])).toBeNull();
  });
});
