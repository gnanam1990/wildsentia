import { ISLAND_GRID } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
import { congoHeightFn } from '@vana/shared';
import { congoTexture } from './congoTextures.js';
import * as THREE from 'three';
import { ISLAND_SEGMENTS, treeAnchorForPatch, treeAnchorRemnantForPatch } from '@vana/shared';
import { islandHeightField } from './islandHeightField.js';
import { groundTint } from './groundTint.js';
import { BANK_CLEAR_M, insidePool, islandPool, waterGround, type Pool } from './pools.js';
import { buildPools, poolPlane } from './poolScene.js';
import { patchCentre } from './space.js';

export interface PatchView {
  id: number;
  x: number;
  y: number;
  habitat: string;
  grass: number;
  browse: number;
  /** Checkpointed aggregate model proxy, never an individual bee/flower observation. */
  floweringGuild?: null | {
    guildId: 'insect_visited_understorey_v1'; vegetativeKg: number;
    openKg: number; visitedKg: number; seedKg: number;
    stage: 'vegetative' | 'flowering' | 'maturing' | 'seed_bank';
    nextEligibleAt: number | null;
  };
  water: number;
  /** 0-1 as the simulation stores it. Scaled to metres for relief. */
  elevation?: number;
  canopyCover?: number;
  islandSeed?: number;
  surface?: 'land' | 'coast' | 'ocean';
  /** Congo 1A.4: the Congo forest's terrain seed, its flood and its deep river. */
  congoSeed?: number;
  flooded?: boolean;
  deepWater?: boolean;
  /** Last authoritative hydrology step. The renderer never invents flow when absent. */
  drainage?: {
    downstreamPatchId: number | null;
    boundaryOutlet: boolean;
    inflowL: number;
    outflowL: number;
    hours: number;
  };
}

/** Metres of relief across the full 0-1 elevation range the simulation reports. */
const RELIEF_M = 90;
const TREES_PER_PATCH = 300;
/** The most far-field trees drawn at once: the island's whole forest (400 patches) at full density. */
const TREE_BUDGET = 120_000;

export function patchHeight(patch: PatchView): number {
  return (patch.elevation ?? 0.5) * RELIEF_M;
}

export type HeightSampler = (x: number, z: number) => number;

/** Full immutable identity of the inputs to makeHeightSampler (not a lossy hash). */
export function terrainHeightKey(patches: readonly PatchView[]): string {
  const seed = patches[0]?.islandSeed;
  return JSON.stringify(seed === undefined ? patches.map((p) => [p.id, patchHeight(p)]) : ['island', seed]);
}

/**
 * Heights of the (cols+1) × (rows+1) ground-mesh corners: each the average of the patches that meet there.
 * The drawn ground and the height sampler both read these, so they cannot disagree.
 */
function cornerHeights(patches: readonly PatchView[]): { heights: Float64Array; present: Uint8Array } {
  const byId = new Map<number, PatchView>();
  for (const patch of patches) byId.set(patch.id, patch);
  const { cols, rows } = worldGrid();
  const heights = new Float64Array((cols + 1) * (rows + 1));
  const present = new Uint8Array((cols + 1) * (rows + 1));
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      let sum = 0;
      let n = 0;
      for (const [dc, dr] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const patch = byId.get(r * cols + c);
        if (patch === undefined) continue;
        sum += patchHeight(patch);
        n++;
      }
      const i = row * (cols + 1) + col;
      heights[i] = n > 0 ? sum / n : 0;
      present[i] = n > 0 ? 1 : 0;
    }
  }
  return { heights, present };
}

/**
 * Ground height in metres at a world position: the surface of the drawn ground mesh itself,
 * interpolated across the same two triangles per cell that three.js builds. It once returned
 * the flat height of the patch a point fell in, and on slopes animals stood metres inside the
 * hillside — a gaur was found 2.6 m underground, invisible.
 */
export function makeHeightSampler(patches: readonly PatchView[]): HeightSampler {
  const islandSeed = patches[0]?.islandSeed;
  if (islandSeed !== undefined) return islandHeightField(islandSeed).sample;
  const congoSeed = patches[0]?.congoSeed;
  if (congoSeed !== undefined) return congoLattice(congoSeed).sample;
  const { heights } = cornerHeights(patches);
  const { cols, rows, patchM } = worldGrid();
  const at = (col: number, row: number): number => heights[row * (cols + 1) + col]!;

  return (x, z) => {
    // Corner (col, row) sits at (col·300 − 150, row·300 − 150): the patch centres are cell centres.
    const gx = Math.min(cols - 1e-9, Math.max(0, (x + patchM / 2) / patchM));
    const gz = Math.min(rows - 1e-9, Math.max(0, (z + patchM / 2) / patchM));
    const col = Math.floor(gx);
    const row = Math.floor(gz);
    const fx = gx - col;
    const fz = gz - row;
    const a = at(col, row);
    const b = at(col, row + 1);
    const c = at(col + 1, row + 1);
    const d = at(col + 1, row);
    // PlaneGeometry splits each cell into triangles (a, b, d) and (b, c, d).
    return fx + fz <= 1
      ? a + (d - a) * fx + (b - a) * fz
      : c + (b - c) * (1 - fx) + (d - c) * (1 - fz);
  };
}


/** Metres. A sambar stands 1.35 m at the shoulder, so grass must be ankle height, not tree height. */
const GRASS_HEIGHT_M = 0.85;
const GRASS_RADIUS_M = 0.14;
const TUFTS_PER_PATCH = 64;

/**
 * Counts what the GPU would have to draw. Every Mesh, InstancedMesh, Points and Line is one
 * call regardless of how much geometry it carries — which is exactly why vegetation is
 * instanced rather than cloned per patch.
 */
export function countDrawCalls(root: THREE.Object3D): number {
  let calls = 0;
  root.traverse((object) => {
    const o = object as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean };
    if (o.isMesh === true || o.isPoints === true || o.isLine === true) calls++;
  });
  return calls;
}

function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  name: string,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, 1));
  mesh.name = name;
  mesh.count = count;
  mesh.frustumCulled = false;
  return mesh;
}

interface FlowBuild {
  river: THREE.Mesh | null;
  waterfall: THREE.Mesh | null;
}

/**
 * Draws only the water that the server's completed drainage step says left a patch.
 * This is deliberately a presentation of stored flow, not a client-side hydraulic solve.
 * Each reach is a narrow ribbon (one draw call) and steep reaches get a vertical curtain so
 * the island's downhill channels read as rivers and falls without filling the whole grid with
 * invented lakes.
 */
function buildDrainageFlow(patches: readonly PatchView[], groundAt: HeightSampler): FlowBuild {
  const byId = new Map(patches.map((p) => [p.id, p]));
  const riverPositions: number[] = [];
  const waterfallPositions: number[] = [];
  const riverUvs: number[] = [];
  const waterfallUvs: number[] = [];
  const riverIndices: number[] = [];
  const waterfallIndices: number[] = [];
  let riverVertex = 0;
  let waterfallVertex = 0;
  const point = (patch: PatchView): { x: number; z: number } => patchCentre(worldGrid(), patch.id);
  const surfaceHeight = (patch: PatchView): number => {
    const p = point(patch);
    return patch.surface === 'ocean' ? 0 : groundAt(p.x, p.z);
  };

  for (const patch of patches) {
    const flow = patch.drainage;
    if (!flow || !Number.isFinite(flow.outflowL) || flow.outflowL <= 25 || flow.downstreamPatchId === null) continue;
    const downstream = byId.get(flow.downstreamPatchId);
    if (!downstream) continue;
    const a = point(patch), b = point(downstream);
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length <= 0) continue;
    const nx = -dz / length, nz = dx / length;
    const width = Math.max(1.2, Math.min(12, Math.sqrt(flow.outflowL / 650)));
    const ay = surfaceHeight(patch) + 0.12, by = surfaceHeight(downstream) + 0.12;
    const leftA = [a.x + nx * width, ay, a.z + nz * width];
    const rightA = [a.x - nx * width, ay, a.z - nz * width];
    const leftB = [b.x + nx * width, by, b.z + nz * width];
    const rightB = [b.x - nx * width, by, b.z - nz * width];
    riverPositions.push(...leftA, ...rightA, ...leftB, ...rightB);
    riverUvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    riverIndices.push(riverVertex, riverVertex + 1, riverVertex + 2, riverVertex + 1, riverVertex + 3, riverVertex + 2);
    riverVertex += 4;

    const drop = ay - by;
    if (drop >= 5) {
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const top = Math.max(ay, by + 0.3), bottom = Math.min(ay, by + 0.1);
      const half = width * 0.82;
      waterfallPositions.push(mx + nx * half, top, mz + nz * half,
        mx - nx * half, top, mz - nz * half,
        mx + nx * half, bottom, mz + nz * half,
        mx - nx * half, bottom, mz - nz * half);
      waterfallUvs.push(0, 0, 1, 0, 0, 1, 1, 1);
      waterfallIndices.push(waterfallVertex, waterfallVertex + 1, waterfallVertex + 2,
        waterfallVertex + 1, waterfallVertex + 3, waterfallVertex + 2);
      waterfallVertex += 4;
    }
  }

  const mesh = (positions: number[], uvs: number[], indices: number[], name: string, material: THREE.Material): THREE.Mesh | null => {
    if (positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const output = new THREE.Mesh(geometry, material);
    output.name = name;
    output.frustumCulled = true;
    output.receiveShadow = true;
    return output;
  };
  return {
    river: mesh(riverPositions, riverUvs, riverIndices, 'river', new THREE.MeshStandardMaterial({
      color: 0x3b91a5, roughness: 0.12, metalness: 0.18, transparent: true, opacity: 0.82,
    })),
    waterfall: mesh(waterfallPositions, waterfallUvs, waterfallIndices, 'waterfall', new THREE.MeshStandardMaterial({
      color: 0x9ddbea, roughness: 0.08, metalness: 0.05, transparent: true, opacity: 0.68,
      depthWrite: false,
    })),
  };
}

/**
 * Four instanced meshes carry the entire 400-patch world: ground tiles, grass tufts, water
 * planes and rock. That is four draw calls for the terrain, against 400+ if each patch were
 * its own mesh.
 */

/**
 * A single 21x21-vertex plane displaced by the elevation the simulation reports, coloured per
 * vertex by the habitat of the patches meeting at that corner. Corner values average whatever
 * patches touch them, so habitats blend instead of ending at a hard tile edge.
 */
/** Locally served CC0 scans; data maps stay linear, albedo is sRGB. Each terrain owns its
 * textures so refreshing a snapshot can dispose them without breaking another scene. */
export function scannedGroundMaps(repeat: readonly [number, number] = [worldGrid().cols * worldGrid().patchM / 3.2, worldGrid().rows * worldGrid().patchM / 3.2]):
  Pick<THREE.MeshStandardMaterialParameters, 'map' | 'normalMap' | 'roughnessMap' | 'normalScale'> {
  if (typeof document === 'undefined') return {};
  const loader = new THREE.TextureLoader();
  const load = (suffix: string, colour: boolean): THREE.Texture => {
    const texture = loader.load(`/assets/ground/forest_ground_04_${suffix}_1k.jpg`);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
    texture.anisotropy = 8;
    texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return texture;
  };
  return { map: load('diff', true), normalMap: load('nor_gl', false), roughnessMap: load('rough', false), normalScale: new THREE.Vector2(0.55, 0.55) };
}


/** Congo 1A.4: heights are drawn relative to the forest's lowest ground (250 m above sea). */
export const CONGO_BASE_M = 250;
/** Congo ground mesh step, metres: one vertex every 50 m (a 6 km region is 120 cells a side). */
export const CONGO_STEP_M = 50;

/**
 * The Congo forest's relief on a 50 m lattice, cached by seed: vertex heights, and a sampler over
 * the same two triangles per cell that the drawn mesh uses, so an animal stands on the ground drawn.
 */
let congoCache: { seed: number; vertex: (col: number, row: number) => number; sample: HeightSampler } | null = null;
export function congoLattice(seed: number): { vertex: (col: number, row: number) => number; sample: HeightSampler } {
  if (congoCache?.seed === seed) return congoCache;
  const grid = worldGrid(), height = congoHeightFn(seed, grid);
  const origin = -grid.patchM / 2, width = Math.round(grid.cols * grid.patchM / CONGO_STEP_M) + 1;
  const depth = Math.round(grid.rows * grid.patchM / CONGO_STEP_M) + 1;
  // One slot per lattice vertex (NaN until computed). A point past the forest's edge (a camera
  // ray, say) reads the edge vertex: it never shares a slot with another vertex.
  const memo = new Float32Array(width * depth).fill(NaN);
  const vertex = (col: number, row: number): number => {
    col = Math.max(0, Math.min(width - 1, col)); row = Math.max(0, Math.min(depth - 1, row));
    const key = row * width + col;
    let h = memo[key]!;
    if (Number.isNaN(h)) { h = memo[key] = height(origin + col * CONGO_STEP_M, origin + row * CONGO_STEP_M) - CONGO_BASE_M; }
    return h;
  };
  const sample: HeightSampler = (x, z) => {
    const gx = Math.max(0, (x - origin) / CONGO_STEP_M), gz = Math.max(0, (z - origin) / CONGO_STEP_M);
    const col = Math.floor(gx), row = Math.floor(gz), fx = gx - col, fz = gz - row;
    const a = vertex(col, row), b = vertex(col, row + 1), c = vertex(col + 1, row + 1), d = vertex(col + 1, row);
    return fx + fz <= 1 ? a + (d - a) * fx + (b - a) * fz : c + (b - c) * (1 - fx) + (d - c) * (1 - fz);
  };
  congoCache = { seed, vertex, sample };
  return congoCache;
}

/**
 * Congo 1A.4: the height of a water patch's surface, from its ground sampled every 25 m. A river
 * stands 3.6 m over its lowest bed (congo_terrain_v1 cuts the channel 4 m); flood water 0.5 m over
 * the patch's median ground, so it fills the low half of a sloping patch, not only its centre.
 */
export function congoWaterLevel(patch: Pick<PatchView, 'id' | 'habitat'>, groundAt: HeightSampler): number {
  const centre = patchCentre(worldGrid(), patch.id), half = worldGrid().patchM / 2, heights: number[] = [];
  for (let dz = -half + 12.5; dz < half; dz += 25) for (let dx = -half + 12.5; dx < half; dx += 25)
    heights.push(groundAt(centre.x + dx, centre.z + dz));
  heights.sort((a, b) => a - b);
  return patch.habitat === 'water' ? heights[0]! + 3.6 : heights[heights.length >> 1]! + 0.5;
}

/**
 * Congo 1A.4: one ground mesh on the 50 m lattice over the loaded regions only (an L of three
 * regions draws three, not their bounding box), its soil texture laid by world position.
 */
function buildCongoGround(patches: readonly PatchView[], seed: number): THREE.Mesh {
  const grid = worldGrid(), side = grid.regionPatches;
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  const loaded = new Set<string>();
  for (const p of patches) {
    loaded.add(`${Math.floor(p.x / side)},${Math.floor(p.y / side)}`);
    c0 = Math.min(c0, Math.floor(p.x / side)); c1 = Math.max(c1, Math.floor(p.x / side));
    r0 = Math.min(r0, Math.floor(p.y / side)); r1 = Math.max(r1, Math.floor(p.y / side));
  }
  const per = Math.round(side * grid.patchM / CONGO_STEP_M);
  const cols = (c1 - c0 + 1) * per, rows = (r1 - r0 + 1) * per, lattice = congoLattice(seed);
  const spanX = cols * CONGO_STEP_M, spanZ = rows * CONGO_STEP_M, x0 = -grid.patchM / 2 + c0 * per * CONGO_STEP_M, z0 = -grid.patchM / 2 + r0 * per * CONGO_STEP_M;
  const geometry = new THREE.PlaneGeometry(spanX, spanZ, cols, rows).rotateX(-Math.PI / 2);
  geometry.translate(x0 + spanX / 2, 0, z0 + spanZ / 2);
  const position = geometry.attributes.position!;
  for (let i = 0; i < position.count; i++) {
    const col = i % (cols + 1), row = Math.floor(i / (cols + 1));
    position.setY(i, lattice.vertex(c0 * per + col, r0 * per + row));
  }
  // Two triangles a cell, a cell's six indices at (row * cols + col) * 6: keep the loaded regions' cells.
  const all = geometry.index!.array, kept: number[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    if (!loaded.has(`${c0 + Math.floor(col / per)},${r0 + Math.floor(row / per)}`)) continue;
    const o = (row * cols + col) * 6;
    for (let k = 0; k < 6; k++) kept.push(all[o + k]!);
  }
  geometry.setIndex(kept);
  // One 3.2 m soil tile wherever the ground is, so it neither shrinks nor shifts as regions load.
  const uv = geometry.attributes.uv!;
  for (let i = 0; i < position.count; i++) uv.setXY(i, position.getX(i) / 3.2, position.getZ(i) / 3.2);
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(position.count * 3).fill(1), 3));
  geometry.computeVertexNormals();
  // The Congo floor: a photographed leaf litter, a tile every 1.6 m, over the scanned soil's relief.
  // Its own copy, as the terrain's textures are disposed with it.
  const litter = congoTexture('floor_litter')?.clone() ?? null;
  if (litter) litter.repeat.set(2, 2);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, ...scannedGroundMaps([1, 1]), ...(litter ? { map: litter } : {}) });
  groundTint.apply(material);
  if (litter) crossLitter(material);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ground'; mesh.receiveShadow = true;
  return mesh;
}

/**
 * Crosses the leaf litter with a turned, larger copy of itself where a slow noise says, so its
 * 1.6 m repeat does not show as a pattern across the floor.
 */
function crossLitter(material: THREE.MeshStandardMaterial): void {
  const tinted = material.onBeforeCompile, key = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    tinted(shader, renderer);
    shader.fragmentShader = `float litterHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float litterNoise(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(litterHash(i), litterHash(i + vec2(1.0, 0.0)), u.x), mix(litterHash(i + vec2(0.0, 1.0)), litterHash(i + vec2(1.0, 1.0)), u.x), u.y); }
` + shader.fragmentShader.replace('#include <map_fragment>', `#ifdef USE_MAP
      vec4 litterA = texture2D(map, vMapUv);
      vec4 litterB = texture2D(map, mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.63 + 0.29);
      vec4 litterTex = mix(litterA, litterB, smoothstep(0.3, 0.7, litterNoise(vMapUv * 0.11)));
      // Damp, shaded litter: a little darker and less red than the photograph's dry leaves.
      litterTex.rgb = mix(vec3(dot(litterTex.rgb, vec3(0.3, 0.55, 0.15))), litterTex.rgb, 0.75) * 0.8;
      // Drifts of fresher and older, wetter litter a few metres across, so no grid shows from above.
      litterTex.rgb *= 0.72 + 0.5 * litterNoise(vMapUv * 0.37 + 3.1) * litterNoise(vMapUv * 0.9 + 7.7);
      diffuseColor *= litterTex;
      #endif`);
  };
  material.customProgramCacheKey = () => `${key.call(material)}:congo-litter-v4`;
}

function buildGroundMesh(patches: readonly PatchView[]): THREE.Mesh {
  if (patches[0]?.congoSeed !== undefined) return buildCongoGround(patches, patches[0].congoSeed);
  if (patches[0]?.islandSeed !== undefined) return buildIslandGround(patches, patches[0].islandSeed);
  const { cols, rows, patchM } = worldGrid(), spanX = cols * patchM, spanZ = rows * patchM;
  const geometry = new THREE.PlaneGeometry(spanX, spanZ, cols, rows).rotateX(-Math.PI / 2);
  geometry.translate(spanX / 2 - patchM / 2, 0, spanZ / 2 - patchM / 2);

  const position = geometry.attributes.position!;
  const colours = new Float32Array(position.count * 3);
  const { heights, present } = cornerHeights(patches);
  for (let i = 0; i < position.count; i++) if (present[i] === 1) position.setY(i, heights[i]!);

  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.computeVertexNormals();

  // Habitat colour now comes from the checkpointed ground tint (groundTint.ts); the vertex
  // colours are only a sand mask, and the mainland has no beaches.
  colours.fill(1);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0,
    // Scanned soil, stones and surface normals, tinted by grass, canopy and season.
    ...scannedGroundMaps(),
  });
  groundTint.apply(material);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  return mesh;
}

function buildIslandGround(patches: readonly PatchView[], seed: number): THREE.Mesh {
  const field = islandHeightField(seed);
  // Island geometry is defined on the 20 × 20 island lattice.
  const span = ISLAND_GRID.cols * ISLAND_GRID.patchM;
  const geometry = new THREE.PlaneGeometry(span, span, ISLAND_SEGMENTS, ISLAND_SEGMENTS).rotateX(-Math.PI / 2);
  geometry.translate(span / 2 - ISLAND_GRID.patchM / 2, 0, span / 2 - ISLAND_GRID.patchM / 2);
  const positions = geometry.attributes.position!, colours = new Float32Array(positions.count * 3);
  void patches;
  for (let i = 0; i < positions.count; i++) {
    const col = i % (ISLAND_SEGMENTS + 1), row = Math.floor(i / (ISLAND_SEGMENTS + 1));
    const height = field.vertex(col, row); positions.setY(i, height);
    // Vertex colour is a sand mask for the tint shader: blue channel 0 on the beach, 1 inland.
    const sand = height < 6 ? 1 : height < 12 ? (12 - height) / 6 : 0;
    colours.set([1, 1, 1 - sand], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3)); geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, ...scannedGroundMaps() });
  groundTint.apply(material);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ground'; mesh.receiveShadow = true; return mesh;
}

/** An island pool's water plane (see poolScene.ts): tilted to the slope, turned and stretched to its shore. */
export const poolMatrix = poolPlane;

export const TERRAIN_LAYERS = ['ground', 'grass', 'water', 'rock', 'trunk', 'canopy', 'ocean'] as const;
export type TerrainLayer = typeof TERRAIN_LAYERS[number];

/** Optional selection builds only changed layers; it never borrows active scene objects. */
export function buildTerrain(patches: readonly PatchView[], layers?: ReadonlySet<TerrainLayer>): THREE.Group {
  const group = new THREE.Group();
  group.name = 'terrain';
  const wanted = (name: TerrainLayer) => layers?.has(name) ?? true;

  const island = patches[0]?.islandSeed !== undefined;
  const land = (p: PatchView) => p.surface === undefined || p.surface === 'land';
  // Island drinking is allowed at the representative access point for any positive
  // surface-freshwater stock. Keep that point visibly wet even below the old 20 kL
  // large-pool threshold; a 2 m disc covers the 1.5 m actor-specific approach slots.
  // Mainland's legacy full-patch water planes retain their stricter threshold.
  // Congo 1A.5: its rivers, plants and rocks are drawn by the Congo forest layer (congoForest.ts);
  // this layer draws only its ground.
  const congo = patches[0]?.congoSeed !== undefined;
  const waterPatches = congo ? [] : patches.filter((p) => land(p) && (island
    ? Number.isFinite(p.water) && p.water > 0
    : p.habitat === 'water' || p.water > 20_000));
  const shores = waterGround(patches);
  const rockPatches = congo ? [] : patches.filter((p) => land(p) && p.habitat === 'rock');
  const tuftsPerPatch = TUFTS_PER_PATCH;
  const grassPatches = congo ? [] : patches.filter((p) => land(p) && p.grass > 100 && p.habitat !== 'water' && p.water <= 20_000);

  // One continuous heightmap rather than 400 separate tiles. Tiles at differing elevations
  // leave visible gaps along every shared edge; a single displaced mesh has no seams and costs
  // one draw call instead of an instanced batch.
  const ground = wanted('ground') ? buildGroundMesh(patches) : null;
  const grass = wanted('grass') ? instanced(
    new THREE.ConeGeometry(GRASS_RADIUS_M, GRASS_HEIGHT_M, 3).translate(0, GRASS_HEIGHT_M / 2, 0),
    new THREE.MeshStandardMaterial({ color: 0x5f8a3c, roughness: 1, flatShading: true }),
    grassPatches.length * tuftsPerPatch,
    'grass',
  ) : null;
  // The island's pools are drawn as waterholes (poolScene.ts) once the ground can be sampled.
  const water = wanted('water') && !island ? instanced(
    new THREE.PlaneGeometry(worldGrid().patchM, worldGrid().patchM).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: 0x2f6f86, roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.85,
    }),
    waterPatches.length,
    'water',
  ) : null;
  const rock = wanted('rock') ? instanced(
    new THREE.DodecahedronGeometry(1.6, 0),
    new THREE.MeshStandardMaterial({ color: 0x6d6a60, roughness: 1, flatShading: true }),
    rockPatches.length * 3,
    'rock',
  ) : null;

  // Trees go where the simulation reports canopy, not where they would look nice.
  const woodedPatches = congo ? [] : patches.filter((p) => land(p) && ((p.canopyCover ?? 0) >= 0.3
    || treeAnchorRemnantForPatch(worldGrid(), p) !== null));
  // Congo 1A.4: several loaded regions share the budget, each patch drawing fewer trees.
  const livePatches = woodedPatches.filter((patch) => !treeAnchorRemnantForPatch(worldGrid(), patch)).length;
  const treesPerPatch = Math.max(1, Math.min(TREES_PER_PATCH, Math.floor(TREE_BUDGET / Math.max(1, livePatches))));
  const treeCount = woodedPatches.reduce((sum, patch) => sum + (treeAnchorRemnantForPatch(worldGrid(), patch) ? 1 : treesPerPatch), 0);
  const liveTreeCount = livePatches * treesPerPatch;
  const trunk = wanted('trunk') ? instanced(
    new THREE.CylinderGeometry(0.22, 0.4, 7, 6).translate(0, 3.5, 0),
    new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 }),
    treeCount,
    'trunk',
  ) : null;
  const canopy = wanted('canopy') ? instanced(
    new THREE.IcosahedronGeometry(3.4, 0),
    new THREE.MeshStandardMaterial({ color: 0x3f6b36, roughness: 1, flatShading: true }),
    liveTreeCount,
    'canopy',
  ) : null;
  if (trunk) trunk.castShadow = true;
  if (canopy) canopy.castShadow = true;

  const matrix = new THREE.Matrix4();
  // Everything stands on the drawn surface, not on its patch's average height: on a slope the
  // difference is metres, enough to float grass in the air or bury a tree to its crown.
  const groundAt = makeHeightSampler(patches);
  const flow = wanted('water') ? buildDrainageFlow(patches, groundAt) : { river: null, waterfall: null };

  let g = 0;
  for (const patch of grass ? grassPatches : []) {
    const centre = patchCentre(worldGrid(), patch.id);
    const density = Math.min(1, patch.grass / 6000);
    const pool = island ? islandPool(patch, shores) : null;
    let seed = patch.id * 2654435761;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < tuftsPerPatch; i++) {
      matrix.makeScale(1, 0.5 + density, 1);
      const gx = centre.x + (random() - 0.5) * worldGrid().patchM;
      const gz = centre.z + (random() - 0.5) * worldGrid().patchM;
      // A tuft that would stand in the pool is sunk out of sight; the instance count stays fixed.
      const wet = pool !== null && insidePool(pool, gx, gz, BANK_CLEAR_M(pool));
      if (wet) matrix.makeScale(0, 0, 0);
      matrix.setPosition(gx, groundAt(gx, gz), gz);
      grass!.setMatrixAt(g++, matrix);
    }
  }

  (water ? waterPatches : []).forEach((patch, index) => {
    // The mainland's legacy full-patch water; island pools are drawn by buildPools.
    const centre = patchCentre(worldGrid(), patch.id);
    const y = patch.congoSeed !== undefined ? congoWaterLevel(patch, groundAt) : patchHeight(patch) + 0.4;
    matrix.makeTranslation(centre.x, y, centre.z);
    water!.setMatrixAt(index, matrix);
  });

  let r = 0;
  for (const patch of rock ? rockPatches : []) {
    const centre = patchCentre(worldGrid(), patch.id);
    for (let i = 0; i < 3; i++) {
      matrix.makeScale(1 + i * 0.3, 0.7, 1 + i * 0.2);
      const rx = centre.x + (i - 1) * 70;
      const rz = centre.z + (i - 1) * 50;
      matrix.setPosition(rx, groundAt(rx, rz) + 0.6, rz);
      rock!.setMatrixAt(r++, matrix);
    }
  }

  let t = 0, c = 0;
  for (const patch of trunk || canopy ? woodedPatches : []) {
    const centre = patchCentre(worldGrid(), patch.id);
    const anchor = treeAnchorForPatch(worldGrid(), patch);
    const remnant = treeAnchorRemnantForPatch(worldGrid(), patch);
    let seed = (patch.id + 7919) * 2246822519;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < (remnant ? 1 : treesPerPatch); i++) {
      const plannedX = centre.x + (random() - 0.5) * worldGrid().patchM * 0.94;
      const plannedZ = centre.z + (random() - 0.5) * worldGrid().patchM * 0.94;
      const plannedScale = 0.7 + random() * 0.9;
      const tx = i === 0 && (anchor || remnant) ? (anchor ?? remnant)!.x : plannedX;
      const tz = i === 0 && (anchor || remnant) ? (anchor ?? remnant)!.z : plannedZ;
      const scale = i === 0 && (anchor || remnant) ? 1.8 : plannedScale;
      const base = groundAt(tx, tz);

      matrix.makeScale(scale, scale, scale);
      matrix.setPosition(tx, base, tz);
      trunk?.setMatrixAt(t, matrix);

      matrix.makeScale(scale, scale * 0.8, scale);
      matrix.setPosition(tx, base + 7 * scale, tz);
      if (!remnant) canopy?.setMatrixAt(c++, matrix);
      t++;
    }
  }

  for (const mesh of [grass, water, rock, trunk, canopy]) {
    if (!mesh) continue;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  }
  for (const mesh of [flow.river, flow.waterfall]) if (mesh) group.add(mesh);
  if (island && wanted('water')) {
    group.add(buildPools(waterPatches.flatMap((p) => { const pool = islandPool(p, shores); return pool ? [pool as Pool] : []; }), groundAt));
  }
  // Kept so the far-field can be hidden near the camera and restored exactly (hideFarFieldNear).
  for (const mesh of [grass, rock, trunk, canopy]) {
    if (!mesh) continue;
    mesh.userData.base = (mesh.instanceMatrix.array as Float32Array).slice();
  }
  if (ground) group.add(ground);
  if (island && wanted('ocean')) {
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(60_000, 60_000).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x235667, roughness: 0.38, metalness: 0.05 }));
    ocean.name = 'ocean'; ocean.position.set((ISLAND_GRID.cols - 1) * ISLAND_GRID.patchM / 2, 0, (ISLAND_GRID.rows - 1) * ISLAND_GRID.patchM / 2);
    group.add(ocean);
  }
  return group;
}

const FAR_FIELD = ['grass', 'rock', 'trunk', 'canopy'] as const;

/**
 * The world-wide vegetation is cheap stand-ins: cones and blocks that read as forest from a
 * distance. Where the detailed plants are drawn around the camera, the stand-ins are hidden so
 * they can use independent detail radii. Grass overlaps its tapered edge slightly;
 * everywhere outside those radii the original instances are restored exactly.
 */
export function hideFarFieldNear(terrain: THREE.Object3D, focus: { x: number; z: number }, radiusM: number, treeRadiusM = radiusM, grassRadiusM = radiusM): void {
  for (const name of FAR_FIELD) {
    const mesh = terrain.getObjectByName(name) as THREE.InstancedMesh | undefined;
    const base = mesh?.userData.base as Float32Array | undefined;
    if (mesh === undefined || base === undefined) continue;
    // Once matching tree atlases cover the forest, skip the old placeholder draw entirely.
    // Zero-size instance matrices still submit every placeholder vertex to the GPU.
    const replacedTrees = (name === 'trunk' || name === 'canopy') && treeRadiusM === Number.POSITIVE_INFINITY;
    mesh.visible = !replacedTrees;
    if (replacedTrees) continue;
    const out = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 16;
      const radius = name === 'trunk' || name === 'canopy' ? treeRadiusM : name === 'grass' ? grassRadiusM : radiusM;
      const near = Math.hypot(base[o + 12]! - focus.x, base[o + 14]! - focus.z) <= radius;
      if (near) out.fill(0, o, o + 16);
      else out.set(base.subarray(o, o + 16), o);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}
