import * as THREE from 'three';

/**
 * A sky around the observer: a gradient from horizon to zenith, the sun (or moon) with its
 * glow, drifting clouds that thicken with the season's rain, and stars at night. It follows
 * the camera and draws behind everything. Presentation only: the world's clock and seasonal
 * rain decide it, as they decide the light.
 */

const colour = (hex: number) => new THREE.Color(hex);
const PALETTE = {
  day: { zenith: colour(0x3f7fcc), horizon: colour(0xc4dcec) },
  golden: { zenith: colour(0x4a5f9a), horizon: colour(0xf2a766) },
  night: { zenith: colour(0x040a18), horizon: colour(0x14223a) },
  overcast: { zenith: colour(0x6f7d88), horizon: colour(0xa8b3b9) },
};

/** Sky colours for a moment: daylight 0-1, rain 0-1 (the season's). */
export function skyColours(daylight: number, rain: number): { zenith: THREE.Color; horizon: THREE.Color } {
  const d = Math.max(0, Math.min(1, daylight));
  // Golden light where the sun is low: strongest just above the horizon, gone by mid-morning.
  const golden = d > 0 ? Math.max(0, 1 - d / 0.35) : 0;
  const zenith = PALETTE.night.zenith.clone().lerp(PALETTE.day.zenith, Math.sqrt(d)).lerp(PALETTE.golden.zenith, golden * 0.5);
  const horizon = PALETTE.night.horizon.clone().lerp(PALETTE.day.horizon, Math.sqrt(d)).lerp(PALETTE.golden.horizon, golden * 0.75);
  const cloud = Math.max(0, Math.min(1, rain)) * Math.sqrt(d);
  zenith.lerp(PALETTE.overcast.zenith, cloud * 0.6);
  horizon.lerp(PALETTE.overcast.horizon, cloud * 0.5);
  return { zenith, horizon };
}

const vertexShader = `
varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  vec4 world = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
  gl_Position.z = gl_Position.w; // On the far plane: behind everything, never clipped by it.
}`;

const fragmentShader = `
uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDirection; uniform vec3 sunColour;
uniform float daylight; uniform float cloudCover; uniform float time;
varying vec3 vDirection;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int k = 0; k < 5; k++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void main() {
  vec3 d = normalize(vDirection);
  float up = max(d.y, 0.0);
  vec3 sky = mix(horizon, zenith, pow(up, 0.55));
  float facing = max(dot(d, normalize(sunDirection)), 0.0);
  // Glow around the sun, and a disc; at night the same light is a paler moon.
  sky += sunColour * (pow(facing, 12.0) * 0.18 + pow(facing, 220.0) * 0.6) * (0.35 + 0.65 * daylight);
  sky += sunColour * smoothstep(0.9993, 0.9997, facing) * (daylight > 0.0 ? 4.0 : 1.2);
  // Clouds on a plane above the island, thinning toward the horizon so it stays clear.
  if (d.y > 0.02) {
    vec2 plane = d.xz / (d.y + 0.08) * 1.6 + vec2(time * 0.004, time * 0.0015);
    float shape = fbm(plane);
    float amount = smoothstep(1.0 - cloudCover * 0.9, 1.05 - cloudCover * 0.55, shape) * smoothstep(0.02, 0.25, d.y);
    vec3 lit = mix(vec3(0.05, 0.07, 0.11), vec3(1.0, 0.98, 0.95), daylight);
    vec3 dark = mix(vec3(0.02, 0.03, 0.05), vec3(0.45, 0.48, 0.52), daylight);
    vec3 cloud = mix(lit, dark, cloudCover * 0.7) + sunColour * pow(facing, 6.0) * 0.25 * daylight;
    sky = mix(sky, cloud, amount * 0.9);
  }
  // Stars where the night is clear.
  float night = 1.0 - smoothstep(0.0, 0.15, daylight);
  if (night > 0.0 && d.y > 0.0) {
    vec2 cell = floor(d.xz / (d.y + 0.3) * 260.0);
    float star = step(0.9975, hash(cell)) * (0.6 + 0.4 * sin(time * 1.7 + hash(cell + 3.1) * 40.0));
    sky += vec3(star) * night * (1.0 - cloudCover) * up;
  }
  gl_FragColor = vec4(sky, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class SkyDome {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly #uniforms = {
    zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
    sunDirection: { value: new THREE.Vector3(0, 1, 0) }, sunColour: { value: new THREE.Color(0xffeccf) },
    daylight: { value: 1 }, cloudCover: { value: 0 }, time: { value: 0 },
  };

  constructor(radius = 9000) {
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), new THREE.ShaderMaterial({
      uniforms: this.#uniforms, vertexShader, fragmentShader, side: THREE.BackSide, depthWrite: false, fog: false,
    }));
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  /** Returns the horizon colour, so fog can fade the land into exactly this sky. `rain` is cloud cover, 0-1. */
  update(daylight: number, rain: number, sunDirection: THREE.Vector3, sunColour: THREE.Color, seconds: number, eye: THREE.Vector3): THREE.Color {
    const { zenith, horizon } = skyColours(daylight, rain);
    this.#uniforms.zenith.value.copy(zenith);
    this.#uniforms.horizon.value.copy(horizon);
    this.#uniforms.sunDirection.value.copy(sunDirection).normalize();
    this.#uniforms.sunColour.value.copy(sunColour);
    this.#uniforms.daylight.value = daylight;
    this.#uniforms.cloudCover.value = Math.max(0.12, Math.min(1, rain));
    this.#uniforms.time.value = seconds;
    this.mesh.position.copy(eye);
    return horizon;
  }
}
