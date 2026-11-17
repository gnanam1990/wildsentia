import * as THREE from 'three';
import type { RenderTier } from './renderQuality.js';

/**
 * Light under the Congo canopy: shafts of sun slanting down through gaps in the crowns, and
 * the dust and pollen that drift through them. Presentation only; nothing here is simulated.
 *
 * Both are drawn around the eye. The shafts stand in a ring of fixed ground cells (so they stay
 * put as the camera moves past), tilted along the sun's direction and turned to face the eye.
 * The motes wrap round the camera in the vertex shader, so they cost no CPU work per frame.
 */

/** Shafts drawn and motes floating, by graphics tier. */
export const CANOPY_LIGHT_BUDGET: Record<RenderTier, { shafts: number; motes: number }> = {
  smooth: { shafts: 0, motes: 0 },
  balanced: { shafts: 9, motes: 260 },
  high: { shafts: 14, motes: 520 },
};

/** Ground cell a shaft may stand in, metres, and the ring round the eye it is drawn in. */
const CELL_M = 14, NEAR_M = 6, FAR_M = 48;
/** Mote box round the eye, metres. */
const MOTE_BOX_M = 16;

/** Stable 0..1 hash of a ground cell and a salt. */
export function cellHash(cx: number, cz: number, salt: number): number {
  let h = Math.imul(cx | 0, 374761393) ^ Math.imul(cz | 0, 668265263) ^ Math.imul(salt | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** How strongly the light shows: only by day, and only among the trees (not from above them). */
export function shaftStrength(daylight: number, underCanopy: number): number {
  const day = THREE.MathUtils.smoothstep(daylight, 0.25, 0.7);
  return day * THREE.MathUtils.smoothstep(underCanopy, 0.2, 0.8);
}

/** Cells round the eye that hold a shaft, nearest first, up to `count`. */
export function shaftCells(eyeX: number, eyeZ: number, count: number): Array<{ x: number; z: number; width: number; brightness: number }> {
  if (count <= 0) return [];
  const found: Array<{ x: number; z: number; width: number; brightness: number; d: number }> = [];
  const c0x = Math.floor(eyeX / CELL_M), c0z = Math.floor(eyeZ / CELL_M), span = Math.ceil(FAR_M / CELL_M);
  for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) {
    const cx = c0x + dx, cz = c0z + dz;
    // About one cell in three has a gap in the crowns above it.
    if (cellHash(cx, cz, 1) > 0.34) continue;
    const x = (cx + cellHash(cx, cz, 2)) * CELL_M, z = (cz + cellHash(cx, cz, 3)) * CELL_M;
    const d = Math.hypot(x - eyeX, z - eyeZ);
    if (d < NEAR_M || d > FAR_M) continue;
    found.push({ x, z, d, width: 1.6 + cellHash(cx, cz, 4) * 3.4, brightness: 0.55 + cellHash(cx, cz, 5) * 0.45 });
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, count).map(({ x, z, width, brightness }) => ({ x, z, width, brightness }));
}

function shaftTexture(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const w = 64, h = 256, canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d')!, image = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / (w - 1), v = y / (h - 1);
    // Soft across the beam; bright where it reaches the floor, fading up into the crowns.
    const across = Math.pow(Math.sin(Math.PI * u), 2.2);
    const along = Math.min(1, (1 - v) * 6) * Math.pow(v, 0.6);
    const a = Math.round(255 * across * along);
    image.data.set([a, a, a, 255], (y * w + x) * 4);
  }
  g.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

const MOTE_VERTEX = /* glsl */`
uniform vec3 eye;
uniform float time;
uniform float box;
uniform float pixelScale;
attribute float phase;
varying float vFade;
void main() {
  // Each mote drifts on its own slow loop and rises a little, wrapped into the box round the eye.
  vec3 drift = vec3(sin(time * 0.21 + phase * 6.1), sin(time * 0.13 + phase * 3.7) * 0.6 + time * 0.05, cos(time * 0.17 + phase * 4.3)) * 0.9;
  vec3 p = mod(position + drift - eye + box * 0.5, box) - box * 0.5 + eye;
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  float d = -view.z;
  vFade = smoothstep(1.2, 2.5, d) * (1.0 - smoothstep(box * 0.32, box * 0.5, length(p - eye)));
  gl_PointSize = clamp(pixelScale * (0.006 + fract(phase * 13.7) * 0.006) / max(d, 0.1), 1.0, 6.0);
  gl_Position = projectionMatrix * view;
}`;
const MOTE_FRAGMENT = /* glsl */`
uniform vec3 colour;
uniform float strength;
varying float vFade;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c));
  gl_FragColor = vec4(colour * a * strength * vFade, 1.0);
}`;

export class CanopyLight {
  readonly root = new THREE.Group();
  readonly #shafts: THREE.InstancedMesh;
  readonly #motes: THREE.Points;
  readonly #moteMaterial: THREE.ShaderMaterial;
  readonly #shaftMaterial: THREE.MeshBasicMaterial;
  #tier: RenderTier = 'balanced';
  readonly #m = new THREE.Matrix4();
  readonly #basis = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(), p: new THREE.Vector3() };
  readonly #colour = new THREE.Color();
  readonly #tint = new THREE.Color();
  readonly #along = new THREE.Vector3();

  constructor(maxShafts = CANOPY_LIGHT_BUDGET.high.shafts, maxMotes = CANOPY_LIGHT_BUDGET.high.motes) {
    this.root.name = 'canopy-light';
    this.#shaftMaterial = new THREE.MeshBasicMaterial({ map: shaftTexture(), color: 0xffffff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true, opacity: 0 });
    this.#shafts = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.#shaftMaterial, maxShafts);
    this.#shafts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#shafts.frustumCulled = false; this.#shafts.count = 0; this.#shafts.renderOrder = 2;
    this.#shafts.raycast = () => {};
    // Give the mesh its per-shaft colours before it is first drawn, so its shader is built with them.
    for (let i = 0; i < maxShafts; i++) this.#shafts.setColorAt(i, new THREE.Color(1, 1, 1));

    const positions = new Float32Array(maxMotes * 3), phases = new Float32Array(maxMotes);
    for (let i = 0; i < maxMotes; i++) {
      positions.set([cellHash(i, 0, 7) * MOTE_BOX_M, cellHash(i, 1, 7) * MOTE_BOX_M * 0.5, cellHash(i, 2, 7) * MOTE_BOX_M], i * 3);
      phases[i] = cellHash(i, 3, 7);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
    this.#moteMaterial = new THREE.ShaderMaterial({ vertexShader: MOTE_VERTEX, fragmentShader: MOTE_FRAGMENT,
      uniforms: { eye: { value: new THREE.Vector3() }, time: { value: 0 }, box: { value: MOTE_BOX_M }, pixelScale: { value: 600 },
        colour: { value: new THREE.Color(0xfff1cf) }, strength: { value: 0 } },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.#motes = new THREE.Points(geometry, this.#moteMaterial);
    this.#motes.frustumCulled = false; this.#motes.renderOrder = 2;
    this.#motes.raycast = () => {};
    this.root.add(this.#shafts, this.#motes);
  }

  setTier(tier: RenderTier): void { this.#tier = tier; }

  /**
   * @param toSun unit vector from the ground toward the sun
   * @param viewportHeight drawing buffer height in pixels, so motes keep their size on any screen
   */
  update(eye: THREE.Vector3, toSun: THREE.Vector3, sunColour: THREE.Color, daylight: number,
    underCanopy: number, seconds: number, reducedMotion: boolean, viewportHeight: number, groundAt: (x: number, z: number) => number,
    /** Whether crowns close overhead there: no shaft stands in an open clearing or over a river. */
    underCrowns: (x: number, z: number) => boolean = () => true): void {
    const strength = shaftStrength(daylight, underCanopy), budget = CANOPY_LIGHT_BUDGET[this.#tier];
    this.root.visible = strength > 0.01 && (budget.shafts > 0 || budget.motes > 0);
    if (!this.root.visible) return;

    // Shafts: tilted along the sun (never flatter than 35 degrees from level), turned toward the eye.
    const axis = this.#basis.y.copy(toSun);
    if (axis.y < 0.57) { axis.y = 0.57; }
    axis.normalize();
    const cells = shaftCells(eye.x, eye.z, budget.shafts * 2).filter((c) => underCrowns(c.x, c.z)).slice(0, budget.shafts);
    this.#shaftMaterial.opacity = 0.42 * strength;
    this.#colour.copy(sunColour);
    let i = 0;
    for (const cell of cells) {
      const length = 34, base = groundAt(cell.x, cell.z);
      const centre = this.#basis.p.set(cell.x, base, cell.z).addScaledVector(axis, length * 0.5);
      const toEye = this.#basis.z.subVectors(eye, centre);
      toEye.addScaledVector(axis, -toEye.dot(axis));
      if (toEye.lengthSq() < 1e-6) continue;
      toEye.normalize();
      const across = this.#basis.x.crossVectors(axis, toEye).normalize();
      this.#m.makeBasis(across.multiplyScalar(cell.width), this.#along.copy(axis).multiplyScalar(length), toEye);
      this.#m.setPosition(centre);
      this.#shafts.setMatrixAt(i, this.#m);
      this.#shafts.setColorAt(i, this.#tint.copy(this.#colour).multiplyScalar(cell.brightness));
      i++;
    }
    this.#shafts.count = i;
    this.#shafts.instanceMatrix.needsUpdate = true;
    if (this.#shafts.instanceColor) this.#shafts.instanceColor.needsUpdate = true;

    // Motes: brightest by day among the trees; held still for reduced motion.
    const motes = budget.motes;
    this.#motes.geometry.setDrawRange(0, motes);
    this.#motes.visible = motes > 0;
    const u = this.#moteMaterial.uniforms;
    u.eye!.value.copy(eye);
    u.time!.value = reducedMotion ? 0 : seconds;
    u.strength!.value = 0.55 * strength;
    u.pixelScale!.value = viewportHeight * 1.1;
  }

  dispose(): void {
    this.#shafts.geometry.dispose(); this.#shaftMaterial.map?.dispose(); this.#shaftMaterial.dispose();
    this.#motes.geometry.dispose(); this.#moteMaterial.dispose();
  }
}
