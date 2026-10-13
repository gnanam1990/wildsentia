import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Atmosphere, atmosphereAt, observerExposure, observerLights } from '../src/environment.js';

describe('authoritative clock and seasonal atmosphere', () => {
  it('is dark at midnight and brightest at noon', () => {
    expect(atmosphereAt(0, 'dry').daylight).toBe(0);
    expect(atmosphereAt(12 * 3600, 'dry').daylight).toBe(1);
    expect(atmosphereAt(86400, 'dry')).toEqual(atmosphereAt(0, 'dry'));
  });
  it('rains in showers that follow the reported season, the same for every viewer', () => {
    // Showers come and go, but a monsoon day is wetter than a wet-season day, and a dry day barely rains.
    const mean = (season: string) => Array.from({ length: 30 * 48 }, (_, i) => atmosphereAt(i * 1800, season).rain)
      .reduce((a, b) => a + b, 0) / (30 * 48);
    expect(mean('monsoon')).toBeGreaterThan(mean('wet'));
    expect(mean('wet')).toBeGreaterThan(mean('dry'));
    expect(mean('dry')).toBeLessThan(0.02);
    expect(atmosphereAt(0, 'unknown').rain).toBe(0);
    // The same moment looks the same for every viewer, and it stays cloudy between monsoon showers.
    expect(atmosphereAt(123_456, 'monsoon')).toEqual(atmosphereAt(123_456, 'monsoon'));
    const dryMoment = Array.from({ length: 200 }, (_, i) => i * 1800).find((t) => atmosphereAt(t, 'monsoon').rain === 0)!;
    expect(atmosphereAt(dryMoment, 'monsoon').cloud).toBeGreaterThan(0.5);
  });
});

describe('observer exposure', () => {
  it('brightens the night for the viewer without touching daylight', () => {
    expect(observerExposure(1)).toBeCloseTo(1.1);
    expect(observerExposure(0)).toBeGreaterThan(1.7);
    // Close up at night the eye adapts well: dark coats and ground stay readable.
    expect(observerExposure(0, 20)).toBeGreaterThanOrEqual(2.1);
    expect(observerExposure(0.5)).toBeGreaterThan(observerExposure(1));
    expect(observerExposure(-3)).toBe(observerExposure(0));
    // From the island overview the night is darker than close up.
    expect(observerExposure(0, 3000)).toBeLessThan(observerExposure(0, 20));
    expect(observerExposure(0, 3000)).toBeGreaterThan(observerExposure(1, 3000));
    expect(observerExposure(1, 3000)).toBeCloseTo(1.1);
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

  it('dims the moon and sky light over the night overview but not close up or by day', () => {
    const night = atmosphereAt(0, 'dry'), noon = atmosphereAt(12 * 3600, 'dry');
    const nearNight = observerLights(night.daylight, night.sunIntensity, 20);
    const farNight = observerLights(night.daylight, night.sunIntensity, 3000);
    expect(nearNight.sun).toBeCloseTo(night.sunIntensity);
    expect(nearNight.sky).toBeCloseTo(0.85);
    expect(farNight.sun).toBeLessThan(nearNight.sun * 0.6);
    expect(farNight.sky).toBeLessThan(nearNight.sky * 0.6);
    // Overall brightness from above at night, light times exposure, stays under a third of day.
    const total = (l: { sun: number; sky: number }, d: number) => (l.sun + l.sky) * observerExposure(d, 3000);
    expect(total(farNight, night.daylight)).toBeLessThan(total(observerLights(noon.daylight, noon.sunIntensity, 3000), noon.daylight) / 3);
    expect(observerLights(noon.daylight, noon.sunIntensity, 3000).sun).toBeCloseTo(noon.sunIntensity);
  });
});

describe('the Congo haze (1A.5)', () => {
  it('closes the view at the forest floor into a grey-green humid haze, and leaves the island air alone', () => {
    const fogAt = (haze: number) => {
      const scene = new THREE.Scene(); scene.background = new THREE.Color(); scene.fog = new THREE.Fog(0, 200, 2600);
      const atmosphere = new Atmosphere(scene, new THREE.DirectionalLight());
      atmosphere.haze = haze;
      atmosphere.update(10 * 3600, 'transition', 3, new THREE.Vector3(), false, 20);
      return scene.fog as THREE.Fog;
    };
    const clear = fogAt(0), humid = fogAt(1);
    expect(humid.far).toBeLessThan(clear.far);
    expect(humid.near).toBeLessThan(clear.near);
    const hsl = humid.color.getHSL({ h: 0, s: 0, l: 0 });
    expect(hsl.h).toBeGreaterThan(0.2); expect(hsl.h).toBeLessThan(0.45); // toward green
  });
});

describe('inside the Congo forest (1A.5)', () => {
  it('closes the view into dim green depth while the eye is among the trees', () => {
    const fogAt = (under: number) => {
      const scene = new THREE.Scene(); scene.background = new THREE.Color(); scene.fog = new THREE.Fog(0, 200, 2600);
      const atmosphere = new Atmosphere(scene, new THREE.DirectionalLight());
      atmosphere.haze = 1; atmosphere.underCanopy = under;
      atmosphere.update(10 * 3600, 'transition', 3, new THREE.Vector3(), false, 20);
      return scene.fog as THREE.Fog;
    };
    const above = fogAt(0), inside = fogAt(1);
    expect(inside.far).toBeLessThanOrEqual(700);
    expect(inside.color.getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(above.color.getHSL({ h: 0, s: 0, l: 0 }).l * 0.6);
  });
});
