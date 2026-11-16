import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { animateWater, registerWater } from '../src/waterLook.js';

describe('the look of open water', () => {
  it('mirrors as much of the forest and sky as there is light, and forgets a disposed surface', () => {
    const water = registerWater(new THREE.MeshStandardMaterial({ envMapIntensity: 2 }));
    animateWater(10, 1);
    expect(water.envMapIntensity).toBeCloseTo(2);
    animateWater(10, 0);
    // A little at night (moonlight), never the day's shine.
    expect(water.envMapIntensity).toBeCloseTo(0.24);
    animateWater(10, 0.5);
    expect(water.envMapIntensity).toBeCloseTo(2 * (0.12 + 0.44));
    water.dispose();
    water.envMapIntensity = 5;
    animateWater(10, 1);
    expect(water.envMapIntensity).toBe(5);
  });
});
