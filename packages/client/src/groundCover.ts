import * as THREE from 'three';
import { GRID_SIZE, PATCH_METRES, spatialHash } from '@vana/shared';
import type { HeightSampler, PatchView } from './terrain.js';
import { RENDER_BUDGETS, type RenderTier } from './renderQuality.js';
import { BANK_CLEAR_M, insidePool, islandPool } from './pools.js';
import { SWAY, wind } from './wind.js';
import { standDensity } from './forestStructure.js';

export const COVER_RADIUS_M = 144;
export const DENSE_COVER_RADIUS_M = 64;
export const COVER_SPACING_M = 0.5;
const MID_SPACING_M = 2;
const REPLAN_M = 10;
const FULL_FOREGROUND_M = 18;
export const CURVED_BLADE_RADIUS_M = 32;
const CAPACITY: Record<string, number> = { grassland: 9000, shola: 1200, riparian: 5000, marsh: 3500, rock: 300 };
const DENSITY: Record<string, number> = { grassland: 1, shola: 0.72, riparian: 0.9, marsh: 1, rock: 0.18 };

/** How much light reaches the floor here, as a grass multiplier: thin under the clumps a
 * forest's trees gather into, fuller in its clearings. 1 where no stand pattern applies. */
export function coverOpenness(habitat: string, x: number, z: number): number {
  if (habitat === 'shola' || habitat === 'riparian') return 0.3 + 0.95 * (1 - standDensity(x, z));
  if (habitat === 'grassland') return 1.05 - 0.3 * standDensity(x, z);
  return 1;
}

export interface GrassTuft {
  x: number; y: number; z: number; rotation: number; height: number; width: number; tint: number;
}

/** World-anchored microcells: moving the camera never relocates a plant. Visual density only. */
export function planGroundCover(
  patches: readonly PatchView[], focus: { x: number; z: number }, groundAt: HeightSampler,
  tier: RenderTier = 'high',
): GrassTuft[] {
  const result: GrassTuft[] = [];
  for (const _ of visitGroundCover(patches, focus, groundAt, tier, (tuft) => result.push(tuft))) { /* drain reference planner */ }
  return result;
}

/** Yield even over empty/ocean cells, not just accepted plants. A barren scene also has a budget. */
function* visitGroundCover(
  patches: readonly PatchView[], focus: { x: number; z: number }, groundAt: HeightSampler,
  tier: RenderTier, accept: (tuft: GrassTuft) => void,
): Generator<void> {
  const byId = new Map(patches.map((p) => [p.id, p]));
  // No grass standing in a drinking pool: the pool is a flat disc, so blades would pierce it.
  const pools = new Map(patches.flatMap((p) => { const pool = islandPool(p); return pool ? [[p.id, pool] as const] : []; }));
  let cells = 0;
  // Two fixed world grids extend cover without multiplying close-up cost. The outer
  // clumps overlap the fine carpet's tapered edge rather than leaving a bare ring.
  for (const [cell, radius, inner] of [[COVER_SPACING_M, DENSE_COVER_RADIUS_M, 0], [MID_SPACING_M, COVER_RADIUS_M, 52]] as const) {
    for (let gz = Math.floor((focus.z - radius) / cell); gz <= Math.ceil((focus.z + radius) / cell); gz++) {
      for (let gx = Math.floor((focus.x - radius) / cell); gx <= Math.ceil((focus.x + radius) / cell); gx++) {
        if (++cells % 512 === 0) yield;
        const distant = inner > 0;
        // Reject most budgeted microcells before hashing strings, sampling the ground or
        // allocating a tuft. Keep the exact same foreground at every tier.
        const keep = ((Math.imul(gx, 73856093) ^ Math.imul(gz, 19349663)) >>> 0) % RENDER_BUDGETS[tier].grassStride === 0;
        if (!keep && Math.hypot((gx + 0.5) * cell - focus.x, (gz + 0.5) * cell - focus.z) > FULL_FOREGROUND_M + cell) continue;
        let seed = spatialHash(`cover:${distant ? 'mid:' : ''}${gx}:${gz}`);
        const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
        const x = (gx + 0.12 + random() * 0.76) * cell;
        const z = (gz + 0.12 + random() * 0.76) * cell;
        const distance = Math.hypot(x - focus.x, z - focus.z);
        if (distance >= radius || distance < inner) continue;
        // Preserve a dense foreground in every mode. Else retain a stable subset of
        // world cells (not random plants per frame), with no extra terrain height queries.
        if (distance > FULL_FOREGROUND_M && !keep) continue;
        const col = Math.floor((x + PATCH_METRES / 2) / PATCH_METRES);
        const row = Math.floor((z + PATCH_METRES / 2) / PATCH_METRES);
        if (col < 0 || col >= GRID_SIZE || row < 0 || row >= GRID_SIZE) continue;
        const patch = byId.get(row * GRID_SIZE + col);
        if (!patch || patch.surface === 'ocean' || patch.surface === 'coast' || patch.habitat === 'water' || patch.grass <= 0) continue;
        // An island patch's water is its pool, not the whole patch as on the mainland plane.
        const pool = pools.get(patch.id);
        if (pool ? insidePool(pool, x, z, BANK_CLEAR_M(pool)) : patch.water > 20_000) continue;
        const vigour = Math.min(1, patch.grass / (CAPACITY[patch.habitat] ?? 9000));
        // Under a clump of trees the floor is shaded litter; grass crowds into the light gaps.
        // Same stand pattern as the trees (forestStructure.ts); the patch biomass still caps it.
        const open = coverOpenness(patch.habitat, x, z);
        if (random() > Math.sqrt(vigour) * (DENSITY[patch.habitat] ?? 0) * open) continue;
        const rotation = random() * Math.PI * 2;
        // Broad, coherent patches break up the identical height/colour of a planted lawn.
        // This is visual variation only; the server's biomass remains authoritative.
        const meadow = (Math.sin(x * 0.17 + Math.sin(z * 0.09)) + Math.cos(z * 0.21 + x * 0.04) + 2) / 4;
        const habitatHeight = patch.habitat === 'shola' ? 0.95 : patch.habitat === 'rock' ? 0.65 : 1;
        const height = (0.24 + random() * 0.44) * (0.55 + vigour * 0.45) * (0.8 + meadow * 0.2) * habitatHeight
          * (0.8 + 0.25 * Math.min(1, open));
        // Never enlarge far blades into broad triangular leaves merely to fill screen area.
        const width = (0.75 + random() * 0.45) * (distant ? 1.15 : 1);
        const tint = random() * 0.35 + meadow * 0.65;
        // Taper the outer belt rather than drawing a hard circular carpet edge.
        const fade = Math.min(1, (radius - distance) / 12, distant ? (distance - inner) / 8 : 1);
        accept({ x, y: groundAt(x, z), z, rotation, height: height * fade, width, tint });
      }
    }
  }
}

/** Same twelve tapered blades at two tessellations: 84 triangles close, 36 at distance.
 * Both sample the same centreline/root/tip, so changing detail never replaces the plant.
 * Colours are authored in sRGB then converted to linear, like the tree albedo textures. */
export function grassTuftGeometry(segments: 2 | 4 = 4): THREE.BufferGeometry {
  const positions: number[] = []; const colours: number[] = []; const indices: number[] = [];
  const root = new THREE.Color('#344f27'), leaf = new THREE.Color('#7b944c'), tip = new THREE.Color('#a2a565');
  const colour = new THREE.Color();
  for (let blade = 0; blade < 12; blade++) {
    const angle = blade * 2.39996;
    const ux = Math.cos(angle); const uz = Math.sin(angle);
    const spread = 0.035 + (blade % 3) * 0.028;
    const cx = uz * spread; const cz = ux * spread;
    const h = 0.57 + ((blade * 3) % 7) * 0.07;
    const lean = 0.10 + (blade % 4) * 0.045;
    const halfWidth = 0.010 + (blade % 3) * 0.003;
    const start = positions.length / 3;
    for (let section = 0; section <= segments; section++) {
      const t = section / segments;
      const bend = lean * t * t;
      const y = h * (t - 0.18 * t * t * t);
      const width = halfWidth * (1 - t) * (0.75 + Math.sin(t * Math.PI) * 0.65);
      colour.copy(t < 0.5 ? root : leaf).lerp(t < 0.5 ? leaf : tip, t < 0.5 ? t * 2 : (t - 0.5) * 2);
      colour.multiplyScalar(0.84 + (blade % 3) * 0.08);
      for (const side of section === segments ? [0] : [-1, 1]) {
        positions.push(cx + ux * side * width + uz * bend, y, cz + uz * side * width - ux * bend);
        colours.push(colour.r, colour.g, colour.b);
      }
      if (section < segments - 1) {
        const a = start + section * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      } else if (section === segments - 1) {
        const a = start + section * 2;
        indices.push(a, a + 1, a + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** Two bounded instanced draws; GPU wind (wind.ts) only moves blade tips, never simulation state. */
export class GroundCover {
  readonly root = new THREE.Group();
  readonly #meshes: [THREE.InstancedMesh, THREE.InstancedMesh];
  #disposed = false;
  #tier: RenderTier = 'high';
  #lastFocus: { x: number; z: number } | null = null;
  #pending: { focus: { x: number; z: number }; work: Generator<void>; counts: number[] } | null = null;
  readonly #staging: Array<{ matrices: Float32Array; colours: Float32Array }>;
  /** Incomplete CPU work never mutates the visible instance buffers. */
  get preparing(): boolean { return this.#pending !== null; }

  constructor(private patches: readonly PatchView[], private readonly groundAt: HeightSampler) {
    this.root.name = 'grass-carpet';
    const material = new THREE.MeshStandardMaterial({
      // Vertex/instance colours supply the green; a third tint made shaded blades black.
      color: 0xffffff, vertexColors: true, roughness: 1, side: THREE.DoubleSide,
    });
    material.customProgramCacheKey = () => 'vana-ground-cover-v3';
    // Blades lean with the observer's wind (wind.ts); roots stay planted.
    wind.apply(material, { height: 1, ...SWAY.grass });
    // Geometric upper bound for the whole square; actual circular plan is smaller.
    const capacity = Math.ceil(2 * DENSE_COVER_RADIUS_M / COVER_SPACING_M + 3) ** 2
      + Math.ceil(2 * COVER_RADIUS_M / MID_SPACING_M + 3) ** 2;
    const nearCapacity = Math.ceil(2 * CURVED_BLADE_RADIUS_M / COVER_SPACING_M + 3) ** 2;
    this.#meshes = [new THREE.InstancedMesh(grassTuftGeometry(4), material, nearCapacity),
      new THREE.InstancedMesh(grassTuftGeometry(2), material, capacity)];
    this.#meshes.forEach((mesh, i) => {
      mesh.name = `grass-carpet:${i === 0 ? 'curved' : 'distant'}`; mesh.count = 0;
      mesh.frustumCulled = false; mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 3), 3)
        .setUsage(THREE.DynamicDrawUsage);
      this.root.add(mesh);
    });
    this.#staging = this.#meshes.map((mesh) => ({ matrices: new Float32Array(mesh.instanceMatrix.array.length),
      colours: new Float32Array(mesh.instanceMatrix.count * 3) }));
  }

  setPatches(patches: readonly PatchView[]): void {
    this.patches = patches; this.#lastFocus = null; this.#pending = null;
    // A new checkpoint may have flooded/depleted this ground. Do not retain stale biomass.
    for (const mesh of this.#meshes) mesh.count = 0;
  }
  setQuality(tier: RenderTier): void {
    if (tier === this.#tier) return;
    this.#tier = tier; this.#lastFocus = null; this.#pending = null;
  }
  /** Live viewer passes 2 ms; Infinity retains synchronous offline/test planning.
   * Budget is cooperative (512-cell chunks), not a hard real-time guarantee. */
  update(focus: { x: number; y?: number; z: number }, budgetMs = Infinity): boolean {
    if (this.#disposed) return false;
    this.root.visible = (focus.y ?? this.groundAt(focus.x, focus.z)) - this.groundAt(focus.x, focus.z) < 180;
    if (!this.root.visible) return false;
    if (this.#pending && Math.hypot(focus.x - this.#pending.focus.x, focus.z - this.#pending.focus.z) > COVER_RADIUS_M / 2) {
      this.#pending = null; // A follow/map teleport supersedes an unrelated destination.
    }
    if (!this.#pending) {
      if (this.#lastFocus && Math.hypot(focus.x - this.#lastFocus.x, focus.z - this.#lastFocus.z) < REPLAN_M) return false;
      this.#start({ x: focus.x, z: focus.z });
    }
    const pending = this.#pending!;
    const deadline = performance.now() + Math.max(0, budgetMs);
    // Always progress one chunk, including a zero-budget deterministic test call.
    do {
      if (pending.work.next().done) {
        this.#meshes.forEach((mesh, level) => {
          const count = pending.counts[level]!;
          for (const [attribute, data, size] of [
            [mesh.instanceMatrix, this.#staging[level]!.matrices, count * 16],
            [mesh.instanceColor!, this.#staging[level]!.colours, count * 3],
          ] as const) {
            if (size === 0) continue;
            attribute.array.set(data.subarray(0, size));
            // Preserve pending writes if a hidden/culled buffer has not been uploaded yet.
            const end = Math.max(size, ...attribute.updateRanges.map((r) => r.start + r.count));
            attribute.clearUpdateRanges(); attribute.addUpdateRange(0, end); attribute.needsUpdate = true;
          }
          mesh.count = count;
        });
        this.#lastFocus = pending.focus; this.#pending = null;
        return true;
      }
    } while (performance.now() < deadline);
    return false;
  }

  #start(focus: { x: number; z: number }): void {
    const matrix = new THREE.Matrix4(); const rotation = new THREE.Quaternion();
    const position = new THREE.Vector3(); const scale = new THREE.Vector3(); const up = new THREE.Vector3(0, 1, 0);
    const colour = new THREE.Color();
    const counts = [0, 0];
    const work = visitGroundCover(this.patches, focus, this.groundAt, this.#tier, (tuft) => {
      const level = Math.hypot(tuft.x - focus.x, tuft.z - focus.z) < RENDER_BUDGETS[this.#tier].curvedRadius ? 0 : 1;
      const target = this.#staging[level]!; const i = counts[level]!++;
      rotation.setFromAxisAngle(up, tuft.rotation);
      matrix.compose(position.set(tuft.x, tuft.y - 0.01, tuft.z), rotation, scale.set(tuft.width, tuft.height, tuft.width));
      matrix.toArray(target.matrices, i * 16);
      // Subtle warm/cool variation, not another saturated green multiplied into the leaf.
      colour.setRGB(0.78 + tuft.tint * 0.22, 0.88 + tuft.tint * 0.12, 0.72 + tuft.tint * 0.20);
      colour.toArray(target.colours, i * 3);
    });
    this.#pending = { focus, work, counts };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pending = null;
    for (const mesh of this.#meshes) { mesh.dispose(); mesh.geometry.dispose(); }
    (this.#meshes[0].material as THREE.Material).dispose();
    this.root.clear();
  }
}
