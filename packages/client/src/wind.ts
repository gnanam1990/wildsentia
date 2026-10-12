import * as THREE from 'three';
import { atmosphereAt } from './environment.js';
import type { RenderTier } from './renderQuality.js';

/**
 * Wind for the observer: how hard grass, leaves and branches move, and how loud the wind
 * sounds. The simulation has no wind field, so this is a presentation of weather the client
 * already shows, never a claim about measured wind: a calm-to-breezy base by season (the
 * south-west monsoon is the windy one), an afternoon breeze, and a stronger push while a
 * shower is passing (the same showerIntensity that draws the rain). A pure function of world
 * time and season, so every viewer sees the same gust; it changes nothing in the world.
 */

const SEASON_BASE: Readonly<Record<string, number>> = { monsoon: 0.42, wet: 0.32, transition: 0.24, dry: 0.18 };
/** Direction the wind blows toward, radians in the x/z plane: monsoon from the south-west,
 * the dry season's land breeze from the north-east (+x east, +z south). */
const SEASON_HEADING: Readonly<Record<string, number>> = {
  monsoon: -Math.PI / 4, wet: -Math.PI / 3, transition: Math.PI / 2, dry: (3 * Math.PI) / 4,
};

export interface WindState {
  /** 0 calm to 1 a monsoon squall. */
  strength: number;
  /** Heading the wind blows toward, radians in x/z. */
  heading: number;
}

export function windAt(worldTime: number, season: string): WindState {
  if (!Number.isFinite(worldTime)) return { strength: 0, heading: 0 };
  const { rain } = atmosphereAt(worldTime, season);
  const hour = (((worldTime % 86400) + 86400) % 86400) / 3600;
  // Land heats through the day: breeziest mid-afternoon, stillest before dawn.
  const afternoon = 0.5 + 0.5 * Math.cos(((hour - 15) / 24) * Math.PI * 2);
  const base = SEASON_BASE[season] ?? 0.22;
  const strength = Math.min(1, base * (0.7 + 0.5 * afternoon) + 0.5 * rain);
  // A slow veer of up to ±0.3 rad over a few hours, so the direction is not frozen.
  const heading = (SEASON_HEADING[season] ?? 0) + 0.3 * Math.sin(worldTime / 5400);
  return { strength: Math.round(strength * 1000) / 1000, heading };
}

/** Per-material sway, in fractions of the model's own height (so a big tree moves further). */
export interface SwayProfile {
  /** Local-space height of the model's top; the base (y = 0) never moves. */
  height: number;
  /** Whole-plant lean at full strength, as a fraction of height at the top. */
  bend: number;
  /** Extra fast leaf/blade flutter, as a fraction of height; skipped in the smooth tier. */
  flutter: number;
}

export const SWAY: Readonly<Record<'grass' | 'plant' | 'leaves' | 'bark', Omit<SwayProfile, 'height'>>> = {
  grass: { bend: 0.22, flutter: 0.05 },
  plant: { bend: 0.07, flutter: 0.025 },
  leaves: { bend: 0.028, flutter: 0.006 },
  bark: { bend: 0.028, flutter: 0 },
};

/** The lean a vertex at local height `y` gets, matching the GLSL below: zero at and below the base. */
export function swayBend(y: number, height: number): number {
  const h = Math.min(1.5, Math.max(0, y / Math.max(1e-6, height)));
  return h * h;
}

const SWAY_GLSL = /* glsl */ `
#ifdef USE_INSTANCING
{
  vec3 windRoot = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float windPhase = dot(windRoot.xz, vec2(0.071, 0.053));
  float windH = clamp(transformed.y / windSwayHeight, 0.0, 1.5);
  // Quadratic in height: roots and trunk bases stay exactly where obstacles say they are.
  float windBend = windH * windH;
  // A downwind lean that breathes with the gusts; leaves add a cross-wind flutter.
  float windGust = 0.6 + 0.4 * sin(windTime * 0.83 + windPhase);
  vec2 windDir = windDirection;
  float windLean = windStrength * windGust * windBend * windSwayBend * windSwayHeight;
  vec2 windPush = windDir * windLean;
  if (windDetail > 0.5 && windSwayFlutter > 0.0) {
    float windFlutter = sin(windTime * 6.7 + dot(transformed, vec3(2.9, 2.1, 2.5)) + windPhase * 4.0);
    float windShake = windFlutter * windStrength * windH * windSwayFlutter * windSwayHeight;
    windPush += vec2(-windDir.y, windDir.x) * windShake;
    transformed.y += windShake * 0.4;
  }
  // World-space push into this instance's rotated local frame (scale cancels: amplitude is
  // already a fraction of the model's own height, so bigger plants move further in metres).
  vec2 windAxisX = normalize(vec2(instanceMatrix[0][0], instanceMatrix[0][2]));
  vec2 windAxisZ = normalize(vec2(instanceMatrix[2][0], instanceMatrix[2][2]));
  transformed.x += dot(windPush, windAxisX);
  transformed.z += dot(windPush, windAxisZ);
}
#endif
`;

/** One set of uniforms shared by every swaying material, updated once per frame. */
export class Wind {
  readonly time = { value: 0 };
  readonly strength = { value: 0 };
  readonly direction = { value: new THREE.Vector2(1, 0) };
  /** 1 for leaf/blade flutter; 0 is the smooth tier's cheap path (one lean, no flutter). */
  readonly detail = { value: 1 };
  state: WindState = { strength: 0, heading: 0 };

  /** `seconds` is the viewer's clock (smooth motion); weather comes from world time. */
  update(worldTime: number, season: string, seconds: number, reducedMotion: boolean): WindState {
    this.state = windAt(worldTime, season);
    this.time.value = seconds;
    this.strength.value = reducedMotion ? 0 : this.state.strength;
    this.direction.value.set(Math.cos(this.state.heading), Math.sin(this.state.heading));
    return this.state;
  }

  setTier(tier: RenderTier): void { this.detail.value = windDetailFor(tier); }

  /** Adds sway to a material, keeping any earlier shader hooks (fades, tints). */
  apply(material: THREE.Material, profile: SwayProfile): void {
    const previous = material.onBeforeCompile.bind(material);
    const key = material.customProgramCacheKey();
    const height = { value: profile.height }, bend = { value: profile.bend }, flutter = { value: profile.flutter };
    material.onBeforeCompile = (shader, renderer) => {
      previous(shader, renderer);
      Object.assign(shader.uniforms, {
        windTime: this.time, windStrength: this.strength, windDirection: this.direction, windDetail: this.detail,
        windSwayHeight: height, windSwayBend: bend, windSwayFlutter: flutter,
      });
      shader.vertexShader = `uniform float windTime; uniform float windStrength; uniform vec2 windDirection;
uniform float windDetail; uniform float windSwayHeight; uniform float windSwayBend; uniform float windSwayFlutter;
` + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${SWAY_GLSL}`);
    };
    material.customProgramCacheKey = () => `${key}:wind-v1`;
    material.userData.windSway = profile;
    material.needsUpdate = true;
  }
}

export function windDetailFor(tier: RenderTier): number { return tier === 'smooth' ? 0 : 1; }

/** Which sway a nature kind and one of its materials gets; null for rocks and fungi. */
export function swayFor(kind: string, materialName: string): keyof typeof SWAY | null {
  if (/^(Stone_|Rock_|Boulder_|Mushroom_)/.test(kind)) return null;
  if (kind.includes('Tree')) return /leaves/i.test(materialName) ? 'leaves' : 'bark';
  if (/^(Grass_|Clover_|Flower_)/.test(kind)) return 'grass';
  return 'plant';
}

/** The observer's one wind, like the one ground tint. */
export const wind = new Wind();
