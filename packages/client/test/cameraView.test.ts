import { describe, expect, it } from 'vitest';
import { viewMessage } from '../src/camera.js';

// Congo 1A.4: the view the server streams regions for is where the viewer is looking.
describe('the view sent to the server', () => {
  it('centres on the followed animal, not on the camera still gliding toward it', () => {
    const gliding = { x: 4_050, z: 4_050 }, duiker = { x: 28_665, z: 25_488 };
    expect(viewMessage(gliding, 22, duiker)).toEqual({ x: 28_665, z: 25_488, radius: 300 });
  });
  it('centres on the camera when exploring, its radius growing with distance up to 1.5 km', () => {
    expect(viewMessage({ x: 100.4, z: 200.6 }, 400, null)).toEqual({ x: 100, z: 201, radius: 1_200 });
    expect(viewMessage({ x: 0, z: 0 }, 5_000, null).radius).toBe(1_500);
  });
});
