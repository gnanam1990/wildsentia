import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Atmosphere, atmosphereAt, observerExposure } from '../src/environment.js';

describe('authoritative clock and seasonal atmosphere', () => {
  it('is dark at midnight and brightest at noon', () => {
    expect(atmosphereAt(0, 'dry').daylight).toBe(0);
    expect(atmosphereAt(12 * 3600, 'dry').daylight).toBe(1);
    expect(atmosphereAt(86400, 'dry')).toEqual(atmosphereAt(0, 'dry'));
  });
  it('uses the reported season rather than random local weather', () => {
    expect(atmosphereAt(0, 'monsoon').rain).toBeGreaterThan(atmosphereAt(0, 'wet').rain);
    expect(atmosphereAt(0, 'dry').rain).toBe(0);
    expect(atmosphereAt(0, 'unknown').rain).toBe(0);
  });
});

describe('observer exposure', () => {
  it('brightens the night for the viewer without touching daylight', () => {
    expect(observerExposure(1)).toBeCloseTo(1.1);
    expect(observerExposure(0)).toBeGreaterThan(1.7);
    expect(observerExposure(0.5)).toBeGreaterThan(observerExposure(1));
    expect(observerExposure(-3)).toBe(observerExposure(0));
  });
});

describe('monsoon rain', () => {
  it('falls around the viewer wherever the camera is, and thins the fog less from above', () => {
    const scene = new THREE.Scene(); scene.background = new THREE.Color(); scene.fog = new THREE.Fog(0, 200, 2600);
    const atmosphere = new Atmosphere(scene, new THREE.DirectionalLight());
    const focus = new THREE.Vector3(1000, 0, 1000), eye = new THREE.Vector3(4000, 1500, 4000);
    atmosphere.update(12 * 3600, 'monsoon', 3, focus, false, 3000, eye);
    const drops = atmosphere.rain.geometry.drawRange.count / 2;
    expect(drops).toBeGreaterThan(400);
    // Only the drawn drops matter; the buffer's unused tail is zero.
    const positions = atmosphere.rain.geometry.attributes.position!.array as Float32Array;
    for (let i = 0; i < drops * 2; i++) {
      expect(Math.abs(positions[i * 3]! - eye.x)).toBeLessThan(50);
      expect(Math.abs(positions[i * 3 + 1]! - eye.y)).toBeLessThan(35);
      expect(Math.abs(positions[i * 3 + 2]! - eye.z)).toBeLessThan(50);
    }
    expect((scene.fog as THREE.Fog).far).toBeGreaterThanOrEqual(3000 * 2.4);
    atmosphere.update(12 * 3600, 'dry', 3, focus, false, 20, eye);
    expect(atmosphere.rain.geometry.drawRange.count).toBe(0);
  });
});
