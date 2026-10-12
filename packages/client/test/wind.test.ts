import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { showerIntensity } from '@vana/shared';
import { SWAY, swayBend, swayFor, Wind, windAt, windDetailFor } from '../src/wind.js';

const HOUR = 3600;
/** A monsoon hour with a heavy shower and one with none, both mid-afternoon on their day. */
function monsoonHours(): { squall: number; lull: number } {
  let squall = -1, lull = -1;
  for (let day = 0; day < 400 && (squall < 0 || lull < 0); day++) {
    const t = day * 24 * HOUR + 15 * HOUR;
    const rain = showerIntensity(t, 'monsoon');
    if (squall < 0 && rain > 0.9) squall = t;
    if (lull < 0 && rain === 0) lull = t;
  }
  return { squall, lull };
}

describe('observer wind from the weather the client already shows', () => {
  it('maps season, showers and time of day to a bounded, deterministic strength', () => {
    const { squall, lull } = monsoonHours();
    const shower = windAt(squall, 'monsoon').strength, still = windAt(lull, 'monsoon').strength;
    // A passing monsoon shower is markedly windier than the same season between showers.
    expect(shower).toBeGreaterThan(still + 0.3);
    expect(shower).toBeLessThanOrEqual(1);
    // Between showers the monsoon is breezier than the dry season at the same hour.
    let dryDay = 15 * HOUR;
    while (showerIntensity(dryDay, 'dry') > 0) dryDay += 24 * HOUR;
    expect(still).toBeGreaterThan(windAt(dryDay, 'dry').strength);
    // Afternoon breeze over a pre-dawn calm, in the same dry spell.
    expect(windAt(dryDay, 'dry').strength).toBeGreaterThan(windAt(dryDay - 12 * HOUR, 'dry').strength);
    for (let t = 0; t < 30 * 24 * HOUR; t += 1777) for (const season of ['monsoon', 'wet', 'transition', 'dry', 'unknown']) {
      const { strength, heading } = windAt(t, season);
      expect(strength).toBeGreaterThanOrEqual(0); expect(strength).toBeLessThanOrEqual(1);
      expect(Number.isFinite(heading)).toBe(true);
    }
    expect(windAt(squall, 'monsoon')).toEqual(windAt(squall, 'monsoon'));
    expect(windAt(Number.NaN, 'monsoon')).toEqual({ strength: 0, heading: 0 });
    // South-west monsoon blows toward the north-east; the dry-season land breeze the other way.
    expect(Math.cos(windAt(lull, 'monsoon').heading)).toBeGreaterThan(0);
    expect(Math.cos(windAt(dryDay, 'dry').heading)).toBeLessThan(0);
  });

  it('never moves a base: sway is zero at and below the root and grows with height', () => {
    expect(swayBend(0, 8)).toBe(0);
    expect(swayBend(-0.3, 8)).toBe(0);
    expect(swayBend(8, 8)).toBe(1);
    for (let y = 0.5; y <= 8; y += 0.5) expect(swayBend(y, 8)).toBeGreaterThan(swayBend(y - 0.5, 8));
    // Bark and leaves of one tree lean together; leaves only add flutter.
    expect(SWAY.leaves.bend).toBe(SWAY.bark.bend);
    expect(SWAY.bark.flutter).toBe(0);
    expect(swayFor('CommonTree_1', 'Leaves_Spreading')).toBe('leaves');
    expect(swayFor('CommonTree_1', 'Bark')).toBe('bark');
    expect(swayFor('Grass_Wispy_Tall', 'Grass')).toBe('grass');
    expect(swayFor('Fern_1', 'Fern')).toBe('plant');
    for (const rock of ['Rock_Medium_1', 'Boulder_Large', 'Stone_Small', 'Mushroom_Common']) expect(swayFor(rock, 'x')).toBeNull();
  });

  it('shares uniforms, stills for reduced motion and takes a cheap path in the smooth tier', () => {
    const wind = new Wind();
    const { squall } = monsoonHours();
    wind.update(squall, 'monsoon', 12.5, false);
    expect(wind.strength.value).toBe(windAt(squall, 'monsoon').strength);
    expect(wind.time.value).toBe(12.5);
    expect(wind.direction.value.length()).toBeCloseTo(1);
    wind.update(squall, 'monsoon', 13, true);
    expect(wind.strength.value).toBe(0);
    expect(wind.state.strength).toBeGreaterThan(0); // Audio still hears the weather.
    expect(windDetailFor('smooth')).toBe(0); expect(windDetailFor('balanced')).toBe(1); expect(windDetailFor('high')).toBe(1);
    wind.setTier('smooth'); expect(wind.detail.value).toBe(0);
    wind.setTier('high'); expect(wind.detail.value).toBe(1);
  });

  it('injects instanced-only sway after earlier hooks, with its own program key', () => {
    const wind = new Wind();
    const material = new THREE.MeshStandardMaterial();
    let earlier = 0;
    material.onBeforeCompile = () => { earlier++; };
    material.customProgramCacheKey = () => 'earlier-key';
    wind.apply(material, { height: 8, ...SWAY.leaves });
    expect(material.customProgramCacheKey()).toBe('earlier-key:wind-v1');
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: '' };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(earlier).toBe(1);
    expect(shader.vertexShader).toContain('#ifdef USE_INSTANCING');
    expect(shader.vertexShader).toContain('float windBend = windH * windH;');
    expect(shader.vertexShader.indexOf('#include <begin_vertex>')).toBeLessThan(shader.vertexShader.indexOf('windBend'));
    expect(shader.uniforms.windStrength).toBe(wind.strength);
    expect(shader.uniforms.windDetail).toBe(wind.detail);
    expect(shader.uniforms.windSwayHeight!.value).toBe(8);
    expect(material.userData.windSway).toEqual({ height: 8, ...SWAY.leaves });
  });
});
