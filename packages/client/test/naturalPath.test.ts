import { describe, expect, it } from 'vitest';
import { movementAt, type MovementTrace } from '@vana/shared';
import { naturalMovementAt, WANDER, wanderSeed } from '../src/naturalPath.js';

// A grid route as the simulation plans it: two long legs, east then north, with a corner.
const route: MovementTrace = { version: 1, actorId: 'd', startWorldTime: 0, destinationPatchId: 0, goal: 'find_food', completed: true,
  samples: [{ seconds: 0, position: { x: 0, z: 0, heading: 0 } }, { seconds: 200, position: { x: 300, z: 0, heading: 0 } },
    { seconds: 400, position: { x: 300, z: 300, heading: 0 } }] };

describe('natural paths', () => {
  it('passes through every recorded point at its recorded time', () => {
    for (const sample of route.samples) {
      const at = naturalMovementAt(route, sample.seconds, wanderSeed('blue_duiker_0001'));
      expect(at.x).toBeCloseTo(sample.position.x, 6); expect(at.z).toBeCloseTo(sample.position.z, 6);
    }
  });
  it('wanders only a little from the recorded line', () => {
    for (let s = 0; s <= 400; s += 2.5) {
      const drawn = naturalMovementAt(route, s, wanderSeed('blue_duiker_0001')), recorded = movementAt(route, s);
      expect(Math.hypot(drawn.x - recorded.x, drawn.z - recorded.z)).toBeLessThan(WANDER.walker.amplitudeM + 40);
    }
    // Along the middle of a straight leg, within the sway itself.
    const mid = naturalMovementAt(route, 100, wanderSeed('x'));
    expect(Math.abs(mid.z)).toBeLessThanOrEqual(WANDER.walker.amplitudeM + 1e-9 + 25);
  });
  it('does not walk the four compass lines: headings spread over the turn', () => {
    const octants = new Set<number>();
    for (let s = 1; s < 400; s += 3) {
      const h = naturalMovementAt(route, s, wanderSeed('peters_duiker_0042')).heading;
      octants.add(Math.floor((((h % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)));
    }
    expect(octants.size).toBeGreaterThanOrEqual(3);
    const off = [...Array(80).keys()].map((k) => naturalMovementAt(route, 20 + k * 2, wanderSeed('peters_duiker_0042')).heading)
      .filter((h) => Math.abs(Math.sin(2 * h)) > 0.05).length;
    expect(off).toBeGreaterThan(20);
  });
  it('draws each animal its own way, the same way every time', () => {
    const a = naturalMovementAt(route, 90, wanderSeed('a')), b = naturalMovementAt(route, 90, wanderSeed('b'));
    expect(Math.abs(a.z - b.z)).toBeGreaterThan(0.01);
    expect(naturalMovementAt(route, 90, wanderSeed('a'))).toEqual(a);
  });
  it('leaves a still animal exactly where it was recorded', () => {
    const still: MovementTrace = { ...route, samples: [route.samples[0]!, { seconds: 50, position: { x: 0, z: 0, heading: 1 } }] };
    expect(naturalMovementAt(still, 20, 0.3)).toEqual(movementAt(still, 20));
  });
});
