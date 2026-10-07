import * as THREE from 'three';
import { ISLAND_SEGMENTS, treeAnchorForPatch, treeAnchorRemnantForPatch } from '@vana/shared';
import { islandHeightField } from './islandHeightField.js';
import { groundTint } from './groundTint.js';
import { BANK_CLEAR_M, insidePool, islandPool, type Pool } from './pools.js';
import { buildPools, poolPlane } from './poolScene.js';
import { PATCH_METRES, patchCentre } from './space.js';

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
 * Heights of the (GRID+1)² ground-mesh corners: each the average of the patches that meet there.
 * The drawn ground and the height sampler both read these, so they cannot disagree.
 */
function cornerHeights(patches: readonly PatchView[]): { heights: Float64Array; present: Uint8Array } {
  const byId = new Map<number, PatchView>();
  for (const patch of patches) byId.set(patch.id, patch);
  const heights = new Float64Array((GRID + 1) * (GRID + 1));
  const present = new Uint8Array((GRID + 1) * (GRID + 1));
  for (let row = 0; row <= GRID; row++) {
    for (let col = 0; col <= GRID; col++) {
      let sum = 0;
      let n = 0;
      for (const [dc, dr] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= GRID || r >= GRID) continue;
        const patch = byId.get(r * GRID + c);
        if (patch === undefined) continue;
        sum += patchHeight(patch);
        n++;
      }
      const i = row * (GRID + 1) + col;
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
  const { heights } = cornerHeights(patches);
  const at = (col: number, row: number): number => heights[row * (GRID + 1) + col]!;

  return (x, z) => {
    // Corner (col, row) sits at (col·300 − 150, row·300 − 150): the patch centres are cell centres.
    const gx = Math.min(GRID - 1e-9, Math.max(0, (x + PATCH_METRES / 2) / PATCH_METRES));
    const gz = Math.min(GRID - 1e-9, Math.max(0, (z + PATCH_METRES / 2) / PATCH_METRES));
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
  const point = (patch: PatchView): { x: number; z: number } => patchCentre(patch.id);
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
const GRID = 20;

/**
 * A single 21x21-vertex plane displaced by the elevation the simulation reports, coloured per
 * vertex by the habitat of the patches meeting at that corner. Corner values average whatever
 * patches touch them, so habitats blend instead of ending at a hard tile edge.
 */
/** Locally served CC0 scans; data maps stay linear, albedo is sRGB. Each terrain owns its
 * textures so refreshing a snapshot can dispose them without breaking another scene. */
export function scannedGroundMaps(): Pick<THREE.MeshStandardMaterialParameters, 'map' | 'normalMap' | 'roughnessMap' | 'normalScale'> {
  if (typeof document === 'undefined') return {};
  const loader = new THREE.TextureLoader();
  const load = (suffix: string, colour: boolean): THREE.Texture => {
    const texture = loader.load(`/assets/ground/forest_ground_04_${suffix}_1k.jpg`);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(GRID * PATCH_METRES / 3.2, GRID * PATCH_METRES / 3.2);
    texture.anisotropy = 8;
    texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return texture;
  };
  return { map: load('diff', true), normalMap: load('nor_gl', false), roughnessMap: load('rough', false), normalScale: new THREE.Vector2(0.55, 0.55) };
}

function buildGroundMesh(patches: readonly PatchView[]): THREE.Mesh {
  if (patches[0]?.islandSeed !== undefined) return buildIslandGround(patches, patches[0].islandSeed);
  const span = GRID * PATCH_METRES;
  const geometry = new THREE.PlaneGeometry(span, span, GRID, GRID).rotateX(-Math.PI / 2);
  geometry.translate(span / 2 - PATCH_METRES / 2, 0, span / 2 - PATCH_METRES / 2);

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
  const span = GRID * PATCH_METRES;
  const geometry = new THREE.PlaneGeometry(span, span, ISLAND_SEGMENTS, ISLAND_SEGMENTS).rotateX(-Math.PI / 2);
  geometry.translate(span / 2 - PATCH_METRES / 2, 0, span / 2 - PATCH_METRES / 2);
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
  const waterPatches = patches.filter((p) => land(p) && (island
    ? Number.isFinite(p.water) && p.water > 0
    : p.habitat === 'water' || p.water > 20_000));
  const rockPatches = patches.filter((p) => land(p) && p.habitat === 'rock');
  const tuftsPerPatch = TUFTS_PER_PATCH;
  const grassPatches = patches.filter((p) => land(p) && p.grass > 100 && p.habitat !== 'water' && p.water <= 20_000);

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
    new THREE.PlaneGeometry(PATCH_METRES, PATCH_METRES).rotateX(-Math.PI / 2),
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
  const woodedPatches = patches.filter((p) => land(p) && ((p.canopyCover ?? 0) >= 0.3
    || treeAnchorRemnantForPatch(p) !== null));
  const treeCount = woodedPatches.reduce((sum, patch) => sum + (treeAnchorRemnantForPatch(patch) ? 1 : TREES_PER_PATCH), 0);
  const liveTreeCount = woodedPatches.filter((patch) => !treeAnchorRemnantForPatch(patch)).length * TREES_PER_PATCH;
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
    const centre = patchCentre(patch.id);
    const density = Math.min(1, patch.grass / 6000);
    const pool = island ? islandPool(patch) : null;
    let seed = patch.id * 2654435761;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < tuftsPerPatch; i++) {
      matrix.makeScale(1, 0.5 + density, 1);
      const gx = centre.x + (random() - 0.5) * PATCH_METRES;
      const gz = centre.z + (random() - 0.5) * PATCH_METRES;
      // A tuft that would stand in the pool is sunk out of sight; the instance count stays fixed.
      const wet = pool !== null && insidePool(pool, gx, gz, BANK_CLEAR_M(pool));
      if (wet) matrix.makeScale(0, 0, 0);
      matrix.setPosition(gx, groundAt(gx, gz), gz);
      grass!.setMatrixAt(g++, matrix);
    }
  }

  (water ? waterPatches : []).forEach((patch, index) => {
    // The mainland's legacy full-patch water; island pools are drawn by buildPools.
    const centre = patchCentre(patch.id);
    matrix.makeTranslation(centre.x, patchHeight(patch) + 0.4, centre.z);
    water!.setMatrixAt(index, matrix);
  });

  let r = 0;
  for (const patch of rock ? rockPatches : []) {
    const centre = patchCentre(patch.id);
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
    const centre = patchCentre(patch.id);
    const anchor = treeAnchorForPatch(patch);
    const remnant = treeAnchorRemnantForPatch(patch);
    let seed = (patch.id + 7919) * 2246822519;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < (remnant ? 1 : TREES_PER_PATCH); i++) {
      const plannedX = centre.x + (random() - 0.5) * PATCH_METRES * 0.94;
      const plannedZ = centre.z + (random() - 0.5) * PATCH_METRES * 0.94;
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
    group.add(buildPools(waterPatches.flatMap((p) => { const pool = islandPool(p); return pool ? [pool as Pool] : []; }), groundAt));
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
    ocean.name = 'ocean'; ocean.position.set((GRID - 1) * PATCH_METRES / 2, 0, (GRID - 1) * PATCH_METRES / 2);
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
