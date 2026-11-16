import * as THREE from 'three';
import { congoChannelHalfM, congoRivers, riverIndex, type RiverPath } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
import { registerWater, waterLook } from './waterLook.js';
import { CONGO_BASE_M, CONGO_STEP_M, congoLattice } from './terrain.js';

/** The loaded ground, in world metres. */
export interface GroundBounds { minX: number; minZ: number; maxX: number; maxZ: number }
/** The loaded ground: its bounding box and its regions (`col,row`), which need not fill the box. */
export interface LoadedGround extends GroundBounds { regions: ReadonlySet<string> }

/** Water is drawn in this order whatever the camera does: the flood, then tributaries, then the main river over them. */
const RENDER_ORDER = { flood: 1, tributary: 2, main: 3 } as const;

/** A ribbon reaches this far under each bank, so no seam shows where the bed meets the bank. */
const RIVER_TUCK_M = 20;
/** The river stands 3.6 m over its bed, which congo_terrain_v1 cuts 4 m below the river's level. */
const RIVER_BELOW_LEVEL_M = 0.4;
/** Flood water over the flooded forest's floor in the rains. */
export const FLOOD_DEPTH_M = 0.6;

const COLOURS = { main: 0x3a2814, tributary: 0x2a1d0e, flood: 0x2e2414 } as const;

let riverCache: { seed: number; rivers: RiverPath[]; near: ReturnType<typeof riverIndex> } | null = null;
function riversOf(seed: number): NonNullable<typeof riverCache> {
  if (riverCache?.seed !== seed) { const rivers = congoRivers(seed, worldGrid()); riverCache = { seed, rivers, near: riverIndex(rivers) }; }
  return riverCache;
}

/** Tea-coloured blackwater: dark, still, mirroring the forest and the sky through its ripples. */
function waterMaterial(colour: number, opacity: number): THREE.MeshStandardMaterial {
  return registerWater(new THREE.MeshStandardMaterial({ color: colour, roughness: 0.08, metalness: 0, transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
    ...waterLook(1.1, 0.3) }));
}

/** Texture coordinates from world position: one ripple tile every 24 m wherever the water is. */
function worldUv(geometry: THREE.BufferGeometry): void {
  const p = geometry.getAttribute('position'), uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / 24; uv[i * 2 + 1] = p.getZ(i) / 24; }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** One river's course where `loaded` says (within the bounds, or past them), as a ribbon as wide as its channel at the river's own level. */
function riverRibbon(river: RiverPath, loaded: (x: number, z: number) => boolean, half: number): THREE.BufferGeometry | null {
  const positions: number[] = [], index: number[] = [];
  const pts = river.points;
  // A course point is drawn when it, or a neighbour, stands on loaded ground: the ribbon reaches
  // the ground's edge and ends one point (some 200 m) past it, never over unloaded regions.
  const kept = pts.map((p, i) => loaded(p.x, p.z) || (i > 0 && loaded(pts[i - 1]!.x, pts[i - 1]!.z))
    || (i < pts.length - 1 && loaded(pts[i + 1]!.x, pts[i + 1]!.z)));
  let previousKept = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (!kept[i]) { previousKept = false; continue; }
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1, nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
    const w = half + RIVER_TUCK_M, y = p.levelM - RIVER_BELOW_LEVEL_M - CONGO_BASE_M;
    const v = positions.length / 3;
    positions.push(p.x + nx * w, y, p.z + nz * w, p.x - nx * w, y, p.z - nz * w);
    // Wound to face up (the left bank is at +n): the water is seen from above, and lit from above.
    if (previousKept) index.push(v - 2, v, v - 1, v - 1, v, v + 1);
    previousKept = true;
  }
  if (index.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  worldUv(geometry);
  return geometry;
}

/**
 * The flood over the flooded forest in the rains: a sheet just over the ground on the 50 m
 * lattice, in the cells within each river's flood belt. Its edge follows the river's course.
 */
function floodSheet(seed: number, bounds: LoadedGround): THREE.BufferGeometry | null {
  const grid = worldGrid(), { near } = riversOf(seed), lattice = congoLattice(seed), origin = -grid.patchM / 2;
  const c0 = Math.round((bounds.minX - origin) / CONGO_STEP_M), r0 = Math.round((bounds.minZ - origin) / CONGO_STEP_M);
  const cols = Math.round((bounds.maxX - bounds.minX) / CONGO_STEP_M), rows = Math.round((bounds.maxZ - bounds.minZ) / CONGO_STEP_M);
  const positions = new Float32Array((cols + 1) * (rows + 1) * 3), index: number[] = [];
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= cols; col++) {
    const o = (row * (cols + 1) + col) * 3, x = origin + (c0 + col) * CONGO_STEP_M, z = origin + (r0 + row) * CONGO_STEP_M;
    positions[o] = x; positions[o + 1] = lattice.vertex(c0 + col, r0 + row) + FLOOD_DEPTH_M; positions[o + 2] = z;
  }
  const wetCorners = new Uint8Array((cols + 1) * (rows + 1));
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const x = origin + (c0 + col + 0.5) * CONGO_STEP_M, z = origin + (r0 + row + 0.5) * CONGO_STEP_M;
    const at = near(x, z), half = congoChannelHalfM(at.river, grid);
    // The channel itself carries the river ribbon; the flood stands on the belt beside it, on loaded ground.
    if (at.distanceM <= half || at.distanceM > half + at.river.floodBeltM || !bounds.regions.has(regionKey(x, z))) continue;
    const a = row * (cols + 1) + col, b = a + cols + 1;
    for (const v of [a, a + 1, b, b + 1]) wetCorners[v]!++;
    index.push(a, b, a + 1, b, b + 1, a + 1);
  }
  // A corner shared with dry cells sinks under the ground, so the shore is where the water meets
  // the slope inside the cell, not a 50 m step.
  for (let v = 0; v < wetCorners.length; v++) if (wetCorners[v]! > 0 && wetCorners[v]! < 4) positions[v * 3 + 1]! -= FLOOD_DEPTH_M + 0.4;
  if (index.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  worldUv(geometry);
  return geometry;
}

/**
 * The water surface where an animal stands: a river's over its channel, the flood's over the belt
 * beside it in a flooding season, or null on dry ground. Matches what buildCongoWater draws.
 */
export function congoWaterSurface(seed: number, flooded: boolean): (x: number, z: number) => number | null {
  const grid = worldGrid(), { near } = riversOf(seed), ground = congoLattice(seed).sample;
  return (x, z) => {
    const at = near(x, z), half = congoChannelHalfM(at.river, grid);
    if (at.distanceM <= half) return at.levelM - RIVER_BELOW_LEVEL_M - CONGO_BASE_M;
    if (flooded && at.distanceM <= half + at.river.floodBeltM) return ground(x, z) + FLOOD_DEPTH_M;
    return null;
  };
}

/** Congo 1A.5: the rivers within (and just beyond) the loaded ground, and the flood when `flooded`. */
export function buildCongoWater(seed: number, bounds: LoadedGround, flooded: boolean): THREE.Group {
  const group = new THREE.Group();
  group.name = 'congo-water';
  riversOf(seed).rivers.forEach((river, i) => {
    const geometry = riverRibbon(river, (x, z) => bounds.regions.has(regionKey(x, z)), congoChannelHalfM(river, worldGrid()));
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, waterMaterial(COLOURS[river.kind], 0.94));
    mesh.name = `river:${i}`; mesh.receiveShadow = true; mesh.renderOrder = RENDER_ORDER[river.kind];
    group.add(mesh);
  });
  if (flooded) {
    const geometry = floodSheet(seed, bounds);
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, waterMaterial(COLOURS.flood, 0.5));
      mesh.name = 'flood'; mesh.receiveShadow = true; mesh.renderOrder = RENDER_ORDER.flood;
      group.add(mesh);
    }
  }
  return group;
}

/**
 * The rivers past the loaded regions, for the distant forest: the same ribbons, over the regions
 * that are not loaded (each meeting the loaded ribbon one course point inside).
 */
export function buildDistantRivers(seed: number, loadedRegions: ReadonlySet<string>): THREE.Group {
  const group = new THREE.Group();
  group.name = 'distant-rivers';
  riversOf(seed).rivers.forEach((river, i) => {
    const geometry = riverRibbon(river, (x, z) => !loadedRegions.has(regionKey(x, z)), congoChannelHalfM(river, worldGrid()));
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, waterMaterial(COLOURS[river.kind], 0.94));
    mesh.name = `distant-river:${i}`; mesh.renderOrder = RENDER_ORDER[river.kind];
    group.add(mesh);
  });
  return group;
}

/** The region (`col,row`) a point lies in. */
function regionKey(x: number, z: number): string {
  const grid = worldGrid(), span = grid.regionPatches * grid.patchM, origin = -grid.patchM / 2;
  return `${Math.floor((x - origin) / span)},${Math.floor((z - origin) / span)}`;
}
