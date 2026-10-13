import * as THREE from 'three';
import { showerIntensity } from '@vana/shared';
import { SkyDome } from './sky.js';

/** How heavy a shower can get, and how cloudy it stays between showers, by season. */
const SEASON_RAIN: Record<string, number> = { monsoon: 1, wet: 0.75, transition: 0.5, dry: 0.35 };
const SEASON_CLOUD: Record<string, number> = { monsoon: 0.6, wet: 0.4, transition: 0.22, dry: 0.08 };

/**
 * The sky and light at a world time. Rain comes in showers and dry spells (showerIntensity,
 * the same for every viewer) that spread the season's steady modelled rainfall over time;
 * `seasonRain` is that steady level. Presentation only.
 */
export function atmosphereAt(worldTime: number, season: string) {
  const hour = ((worldTime % 86400) + 86400) % 86400 / 3600;
  const angle = (hour - 6) / 24 * Math.PI * 2;
  const daylight = Math.max(0, Math.sin(angle));
  const rain = (SEASON_RAIN[season] ?? 0) * showerIntensity(worldTime, season);
  const cloud = Math.max(SEASON_CLOUD[season] ?? 0, rain);
  const seasonRain = ({ monsoon: 0.8, wet: 0.4, transition: 0.1, dry: 0 } as Record<string, number>)[season] ?? 0;
  return { angle, daylight, rain, cloud, seasonRain, sunIntensity: 0.45 + daylight * (1.85 - cloud * 0.9) };
}

/**
 * Observer exposure: like eyes adjusting to the dark, night is brightened enough that dark
 * coats (boar, gaur) read as animals rather than holes, while the sky and light colour still
 * say it is night. Presentation only; the world's time and light are unchanged.
 */
export function observerExposure(daylight: number, viewDistance = 0): number {
  return 1.1 + (1 - Math.min(1, Math.max(0, daylight))) * (0.35 + 0.65 * closeness(viewDistance));
}

/** 1 near the ground, falling to 0 by 2 km up: close up the eye adapts, from above it does not. */
const closeness = (viewDistance: number) => 1 - Math.min(1, Math.max(0, (viewDistance - 300) / 1700));

const DAY_SKY_LIGHT = new THREE.Color(0xcfe3ef), MOON_SKY_LIGHT = new THREE.Color(0x8fa5cc);

/**
 * Sun (or moon) and sky-light intensities for the observer. At night from high above both
 * fall to a little over half, so the overview reads as a moonlit island, not a dim day;
 * close up they stay as they were so animals remain legible. Presentation only.
 */
export function observerLights(daylight: number, sunIntensity: number, viewDistance = 0): { sun: number; sky: number } {
  const d = Math.min(1, Math.max(0, daylight));
  const dim = 1 - (1 - d) * 0.45 * (1 - closeness(viewDistance));
  return { sun: sunIntensity * dim, sky: (0.85 + d * 0.45) * dim };
}

const HAZE = new THREE.Color(0x9ea67c), INTERIOR = new THREE.Color(0x2c3d24);

export class Atmosphere {
  readonly rain: THREE.LineSegments;
  readonly #positions = new Float32Array(600 * 6);
  readonly #sky = new THREE.Color();
  readonly dome = new SkyDome();
  /** Congo 1A.5: 0 for the island's clear air, 1 for the rainforest's humid haze. */
  haze = 0;
  /** Congo 1A.5: 1 while the eye is among the rainforest's trees, 0 above them. */
  underCanopy = 0;

  constructor(private readonly scene: THREE.Scene, private readonly sun: THREE.DirectionalLight) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.#positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: 0xc3d8e0, transparent: true, opacity: 0.24, depthWrite: false,
    }));
    this.rain.frustumCulled = false;
    scene.add(this.rain, this.dome.mesh);
  }

  update(worldTime: number, season: string, seconds: number, focus: THREE.Vector3, reducedMotion: boolean, viewDistance = 0,
    eye: THREE.Vector3 = focus): void {
    const state = atmosphereAt(worldTime, season);
    this.sun.color.setHex(state.daylight === 0 ? 0xadc8ed : state.daylight < 0.25 ? 0xe7ae7c : 0xffeccf);
    const sunDirection = new THREE.Vector3(Math.cos(state.angle) * 130, 30 + state.daylight * 180, 80);
    // The land fades into the sky's own horizon colour, so there is no seam at the fog line.
    this.#sky.copy(this.dome.update(state.daylight, state.cloud, sunDirection, this.sun.color, seconds, eye));
    (this.scene.background as THREE.Color).copy(this.#sky);
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(this.#sky);
      // Weather thins the view near the ground; from high above the whole island stays visible.
      const far = 2600 - state.rain * 1000;
      this.scene.fog.far = Math.max(far * (1 - 0.35 * this.haze), viewDistance * 2.4);
      this.scene.fog.near = Math.max(200 - 120 * this.haze, viewDistance * 0.9);
      // Congo 1A.5: the rainforest's humid air, a grey-green haze (dimmed with the daylight).
      if (this.haze > 0) this.scene.fog.color.lerp(HAZE.clone().multiplyScalar(0.25 + 0.75 * state.daylight), 0.6 * this.haze);
      // Among the trees the view closes into dim green depth a few hundred metres off.
      if (this.underCanopy > 0) {
        this.scene.fog.color.lerp(INTERIOR.clone().multiplyScalar(0.3 + 0.7 * state.daylight), 0.75 * this.underCanopy);
        this.scene.fog.far += (Math.min(this.scene.fog.far, 650) - this.scene.fog.far) * this.underCanopy;
        this.scene.fog.near += (Math.min(this.scene.fog.near, 40) - this.scene.fog.near) * this.underCanopy;
      }
    }
    const lights = observerLights(state.daylight, state.sunIntensity, viewDistance);
    this.sun.intensity = lights.sun;
    this.sun.target.position.copy(focus);
    this.sun.position.set(focus.x + Math.cos(state.angle) * 130, focus.y + 30 + state.daylight * 180, focus.z + 80);
    this.sun.target.updateMatrixWorld();
    const hemi = this.scene.children.find((o) => (o as THREE.HemisphereLight).isHemisphereLight) as THREE.HemisphereLight | undefined;
    // Moonlit observer exposure keeps silhouettes legible without changing world time.
    if (hemi) {
      hemi.intensity = lights.sky;
      // Sky light cools toward moonlight as the sun goes down.
      hemi.color.copy(DAY_SKY_LIGHT).lerp(MOON_SKY_LIGHT, 1 - state.daylight);
    }
    const count = reducedMotion ? 0 : Math.round(600 * state.rain);
    this.rain.geometry.setDrawRange(0, count * 2);
    // Rain falls around the viewer, wherever the camera is, not in a column over the
    // followed animal: from the island overview it was a small shower in one place.
    for (let i = 0; i < count; i++) {
      const x = eye.x + ((i * 43.71) % 90) - 45;
      const z = eye.z + ((i * 17.37) % 90) - 45;
      const y = eye.y - 25 + ((i * 13.7 - seconds * 22) % 55 + 55) % 55;
      this.#positions.set([x, y, z, x - 0.2, y - 1.3, z], i * 6);
    }
    this.rain.geometry.attributes.position!.needsUpdate = true;
  }
}

/** Dispose only procedurally owned terrain resources, never cached animal/plant assets. */
export function disposeTerrain(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // InstancedMesh owns per-instance GPU buffers in addition to its geometry/material.
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  const textures = new Set<THREE.Texture>();
  for (const material of materials) {
    const standard = material as THREE.MeshStandardMaterial;
    for (const texture of [standard.map, standard.normalMap, standard.roughnessMap]) if (texture) textures.add(texture);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}
