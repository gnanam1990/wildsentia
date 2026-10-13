import * as THREE from 'three';
import { patchCentre, spatialHash } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
import { CONGO_STEP_M, congoLattice, type PatchView } from './terrain.js';
import { CONGO_KINDS, congoLeafDepthMaterial, congoPlantMaterials, congoPlantParts, planCongoPatch, type CongoKind, type PlacedPlant, type PlantParts } from './congoPlants.js';
import { buildCongoWater } from './congoWater.js';

/** How far from the camera's focus each kind of plant is drawn one by one (metres). */
export const KIND_RADIUS_M: Record<CongoKind, number> = {
  emergent: 420, canopy: 380, midstory: 320, raphia: 380, sapling: 200, marantaceae: 140, herb: 70, sedge: 120, log: 260, rock: 300,
};
/** The focus moves this far before the near plants are planted again. */
const REFILL_MOVE_M = 60;
/** The canopy surface's height over the ground in each forest habitat; bais and rivers are open. */
export const CANOPY_HEIGHT_M: Record<string, number> = { terra_firme: 32, flooded_forest: 25, swamp_forest: 17 };
/** The eye's height over the ground at which the canopy's cut-away starts to close, and is closed. */
const HOLE_CLOSES_FROM_M = 60, HOLE_CLOSED_AT_M = 140;
/** Trees stand a little into the ground, so a buttress never floats on a slope. */
const TREE_SINK_M = 0.3;
const TREES = new Set<CongoKind>(['emergent', 'canopy', 'midstory', 'raphia', 'sapling']);

/**
 * Congo 1A.5: the forest of the loaded regions.
 * - Near the camera, plant by plant (instanced, one mesh per kind and part).
 * - Beyond, a canopy surface on the 50 m lattice at each habitat's canopy height, open over
 *   bais and rivers and cut away around the camera, where the plants themselves stand.
 * - The rivers, and the flood in a flooding season.
 */
export class CongoForest {
  readonly root = new THREE.Group();
  /** Where the canopy surface is cut away for the near plants. */
  canopyHole = { x: 0, z: 0, radius: KIND_RADIUS_M.canopy - 40 };
  #patches: readonly PatchView[] = [];
  #seed = 0;
  #plans = new Map<number, PlacedPlant[]>();
  #meshes = new Map<string, THREE.InstancedMesh>();
  #focus: THREE.Vector3 | null = null;
  #shell: THREE.Mesh | null = null;
  #water: THREE.Group | null = null;
  readonly #hole = { centre: { value: new THREE.Vector2() }, radius: { value: this.canopyHole.radius } };

  constructor() { this.root.name = 'congo-forest'; }

  /** A new region set or season: new canopy surface and water; the near plants are planted again on the next update. */
  setScene(patches: readonly PatchView[], seed: number, flooded: boolean): void {
    this.#patches = patches; this.#seed = seed; this.#focus = null;
    for (const id of [...this.#plans.keys()]) if (!patches.some((p) => p.id === id)) this.#plans.delete(id);
    const bounds = boundsOf(patches);
    this.#replace('shell', this.#buildShell(patches, seed));
    this.#replace('water', bounds ? buildCongoWater(seed, bounds, flooded) : null);
  }

  /**
   * Plants again around `focus` once it has moved far enough; returns whether it did. The canopy
   * surface is cut away around the focus only while the eye is down among the trees: from above
   * the canopy the forest is seen whole.
   */
  update(focus: THREE.Vector3, eye: THREE.Vector3 = focus): boolean {
    const above = this.#patches.length ? eye.y - congoLattice(this.#seed).sample(eye.x, eye.z) : 0;
    const t = Math.max(0, Math.min(1, (above - HOLE_CLOSES_FROM_M) / (HOLE_CLOSED_AT_M - HOLE_CLOSES_FROM_M)));
    const radius = Math.round((KIND_RADIUS_M.canopy - 40) * (1 - t * t * (3 - 2 * t)));
    this.#hole.radius.value = radius;
    const moved = !this.#focus || Math.hypot(focus.x - this.#focus.x, focus.z - this.#focus.z) >= REFILL_MOVE_M;
    if (moved) { this.#focus = focus.clone(); this.#hole.centre.value.set(focus.x, focus.z); this.#plant(focus); }
    this.canopyHole = { x: this.#focus!.x, z: this.#focus!.z, radius };
    return moved;
  }

  dispose(): void {
    for (const mesh of this.#meshes.values()) mesh.dispose();
    this.#meshes.clear();
    this.#replace('shell', null); this.#replace('water', null);
  }

  #replace(which: 'shell' | 'water', next: THREE.Mesh | THREE.Group | null): void {
    const old = which === 'shell' ? this.#shell : this.#water;
    if (old) {
      old.removeFromParent();
      old.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    }
    if (next) this.root.add(next);
    if (which === 'shell') this.#shell = next as THREE.Mesh | null; else this.#water = next as THREE.Group | null;
  }

  #plant(focus: THREE.Vector3): void {
    const grid = worldGrid(), ground = congoLattice(this.#seed).sample, reach = Math.max(...Object.values(KIND_RADIUS_M)) + grid.patchM * 0.71;
    const chosen = new Map<CongoKind, PlacedPlant[]>();
    for (const patch of this.#patches) {
      const c = patchCentre(grid, patch.id);
      if (Math.hypot(c.x - focus.x, c.z - focus.z) > reach) continue;
      let plan = this.#plans.get(patch.id);
      if (!plan) { plan = planCongoPatch(patch, this.#seed); this.#plans.set(patch.id, plan); }
      for (const plant of plan) {
        if (Math.hypot(plant.x - focus.x, plant.z - focus.z) > KIND_RADIUS_M[plant.kind]) continue;
        const list = chosen.get(plant.kind) ?? [];
        list.push(plant); chosen.set(plant.kind, list);
      }
    }
    const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tint = new THREE.Color();
    const materials = congoPlantMaterials();
    for (const kind of CONGO_KINDS) {
      const plants = chosen.get(kind) ?? [], parts = congoPlantParts(kind);
      for (const part of Object.keys(parts) as Array<keyof PlantParts>) {
        const mesh = this.#mesh(kind, part, parts[part]!, materials[part], plants.length);
        plants.forEach((plant, i) => {
          p.set(plant.x, ground(plant.x, plant.z) - (TREES.has(kind) ? TREE_SINK_M : 0), plant.z);
          matrix.compose(p, q.setFromAxisAngle(up, plant.rotY), s.setScalar(plant.scale));
          mesh.setMatrixAt(i, matrix);
          // No two plants alike: each its own shade of bark or leaf, fixed by where it stands.
          const v = (plant.rotY / (Math.PI * 2) * 7.31) % 1;
          mesh.setColorAt(i, tint.setRGB(0.8 + 0.35 * v, 0.8 + 0.35 * ((v * 3.7) % 1), 0.8 + 0.3 * ((v * 5.3) % 1)));
        });
        mesh.count = plants.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    }
  }

  /** The instanced mesh for one kind's part, grown when more plants stand near than it holds. */
  #mesh(kind: CongoKind, part: keyof PlantParts, geometry: THREE.BufferGeometry, material: THREE.Material, needed: number): THREE.InstancedMesh {
    const name = `congo:${kind}:${part}`;
    let mesh = this.#meshes.get(name);
    if (!mesh || mesh.instanceMatrix.count < needed) {
      mesh?.removeFromParent(); mesh?.dispose();
      mesh = new THREE.InstancedMesh(geometry, material, Math.max(16, Math.ceil(needed * 1.3)));
      mesh.name = name; mesh.frustumCulled = false;
      // Only the tall trees cast shade, dappled through their leaf clusters (and their trunks).
      mesh.castShadow = kind === 'emergent' || kind === 'canopy';
      if (part === 'leaves') mesh.customDepthMaterial = congoLeafDepthMaterial();
      mesh.receiveShadow = true;
      this.#meshes.set(name, mesh); this.root.add(mesh);
    }
    return mesh;
  }

  /** The canopy surface over the loaded forest: green, bumpy, sloping down to the ground at bais and rivers. */
  #buildShell(patches: readonly PatchView[], seed: number): THREE.Mesh | null {
    const bounds = boundsOf(patches);
    if (!bounds) return null;
    const grid = worldGrid(), lattice = congoLattice(seed), origin = -grid.patchM / 2, byId = new Map(patches.map((p) => [p.id, p]));
    const c0 = Math.round((bounds.minX - origin) / CONGO_STEP_M), r0 = Math.round((bounds.minZ - origin) / CONGO_STEP_M);
    const cols = Math.round((bounds.maxX - bounds.minX) / CONGO_STEP_M), rows = Math.round((bounds.maxZ - bounds.minZ) / CONGO_STEP_M);
    const canopyAt = (x: number, z: number): number => {
      const col = Math.floor((x - origin) / grid.patchM), row = Math.floor((z - origin) / grid.patchM);
      const patch = col >= 0 && row >= 0 && col < grid.cols && row < grid.rows ? byId.get(row * grid.cols + col) : undefined;
      return patch ? CANOPY_HEIGHT_M[patch.habitat] ?? 0 : 0;
    };
    const positions = new Float32Array((cols + 1) * (rows + 1) * 3), colours = new Float32Array((cols + 1) * (rows + 1) * 3), lifted = new Uint8Array((cols + 1) * (rows + 1));
    const light = new THREE.Color(0x4f7a32), dark = new THREE.Color(0x24451c), c = new THREE.Color();
    for (let row = 0; row <= rows; row++) for (let col = 0; col <= cols; col++) {
      const i = row * (cols + 1) + col, x = origin + (c0 + col) * CONGO_STEP_M, z = origin + (r0 + row) * CONGO_STEP_M;
      // The lowest canopy among the four cells around the vertex: the surface drops to the ground at an opening.
      const h = Math.min(canopyAt(x - 25, z - 25), canopyAt(x + 25, z - 25), canopyAt(x - 25, z + 25), canopyAt(x + 25, z + 25));
      const bump = h > 0 ? ((spatialHash(`canopy:${seed}:${c0 + col}:${r0 + row}`) / 0xffffffff) - 0.5) * 8 : 0;
      positions.set([x, lattice.vertex(c0 + col, r0 + row) + Math.max(0, h + bump), z], i * 3);
      lifted[i] = h > 0 ? 1 : 0;
      c.copy(dark).lerp(light, (spatialHash(`canopy-tone:${seed}:${c0 + col}:${r0 + row}`) / 0xffffffff));
      colours.set([c.r, c.g, c.b], i * 3);
    }
    const index: number[] = [];
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const a = row * (cols + 1) + col, b = a + cols + 1;
      if (lifted[a]! + lifted[a + 1]! + lifted[b]! + lifted[b + 1]! === 0) continue;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
    if (index.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
    const hole = this.#hole;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.holeCentre = hole.centre; shader.uniforms.holeRadius = hole.radius;
      shader.vertexShader = 'varying vec3 vShellWorld;\n' + shader.vertexShader.replace('#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvShellWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = `uniform vec2 holeCentre; uniform float holeRadius; varying vec3 vShellWorld;
float shellHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float shellNoise(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(shellHash(i), shellHash(i + vec2(1.0, 0.0)), u.x), mix(shellHash(i + vec2(0.0, 1.0)), shellHash(i + vec2(1.0, 1.0)), u.x), u.y); }
// Treetops: the distance to the nearest crown centre (cellular noise), and that crown's own random.
vec2 shellCrowns(vec2 p) {
  vec2 i = floor(p), f = fract(p); float best = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)), c = i + g;
    vec2 o = vec2(shellHash(c), shellHash(c + 17.31)) * 0.8 + 0.1;
    float d = length(g + o - f);
    if (d < best) { best = d; id = shellHash(c + 3.7); }
  }
  return vec2(best, id);
}
` + shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        // Cut away where the plants themselves stand, with a dithered edge.
        float holeEdge = (distance(vShellWorld.xz, holeCentre) - holeRadius) / 60.0;
        if (holeEdge < shellHash(floor(vShellWorld.xz))) discard;`).replace('#include <color_fragment>', `#include <color_fragment>
        // Treetops: canopy crowns about 16 m across and emergents about 34 m, each domed (lit top,
        // shaded rim, dark gaps between) and each its own green: deep, olive, yellow, a few reddish
        // flushes of new leaves.
        vec2 crown = shellCrowns(vShellWorld.xz / 16.0), big = shellCrowns(vShellWorld.xz / 34.0 + 5.0);
        float dome = 1.0 - smoothstep(0.15, 0.75, crown.x), giant = (1.0 - smoothstep(0.1, 0.55, big.x)) * step(0.8, big.y);
        vec3 tone = mix(vec3(0.62, 0.9, 0.5), vec3(1.05, 1.1, 0.62), crown.y);
        tone = mix(tone, vec3(1.15, 0.85, 0.55), step(0.94, crown.y));
        float leafy = shellNoise(vShellWorld.xz / 2.2) * 0.35 + 0.65;
        diffuseColor.rgb *= tone * mix(0.32, 1.2, max(dome, giant)) * leafy;`);
    };
    material.customProgramCacheKey = () => 'congo-canopy-shell-v2';
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'canopy-shell'; mesh.receiveShadow = false; mesh.castShadow = false;
    return mesh;
  }
}

/** The loaded regions' bounding box in world metres (the ground mesh's extent). */
function boundsOf(patches: readonly PatchView[]): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  if (patches.length === 0) return null;
  const grid = worldGrid(), side = grid.regionPatches, span = side * grid.patchM, origin = -grid.patchM / 2;
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (const p of patches) {
    c0 = Math.min(c0, Math.floor(p.x / side)); c1 = Math.max(c1, Math.floor(p.x / side));
    r0 = Math.min(r0, Math.floor(p.y / side)); r1 = Math.max(r1, Math.floor(p.y / side));
  }
  return { minX: origin + c0 * span, minZ: origin + r0 * span, maxX: origin + (c1 + 1) * span, maxZ: origin + (r1 + 1) * span };
}
