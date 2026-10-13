import * as THREE from 'three';
import { congoChannelHalfM, congoRivers, riverIndex, type RiverPath } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
import { CONGO_BASE_M, CONGO_STEP_M, congoLattice } from './terrain.js';

/** The loaded ground, in world metres. */
export interface GroundBounds { minX: number; minZ: number; maxX: number; maxZ: number }

/** A ribbon reaches this far under each bank, so no seam shows where the bed meets the bank. */
const RIVER_TUCK_M = 20;
/** The river stands 3.6 m over its bed, which congo_terrain_v1 cuts 4 m below the river's level. */
const RIVER_BELOW_LEVEL_M = 0.4;
/** Flood water over the flooded forest's floor in the rains. */
export const FLOOD_DEPTH_M = 0.6;
/** River courses past the loaded ground's edge are drawn this far, so a river never ends at a seam. */
const MARGIN_M = 1500;

const COLOURS = { main: 0x6e5536, tributary: 0x3b2d1d, flood: 0x2f2617 } as const;

let riverCache: { seed: number; rivers: RiverPath[]; near: ReturnType<typeof riverIndex> } | null = null;
function riversOf(seed: number): NonNullable<typeof riverCache> {
  if (riverCache?.seed !== seed) { const rivers = congoRivers(seed, worldGrid()); riverCache = { seed, rivers, near: riverIndex(rivers) }; }
  return riverCache;
}

function waterMaterial(colour: number, opacity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.12, metalness: 0.05, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
}

/** One river's course within the bounds, as a ribbon as wide as its channel at the river's own level. */
function riverRibbon(river: RiverPath, bounds: GroundBounds, half: number): THREE.BufferGeometry | null {
  const inside = (p: { x: number; z: number }) => p.x >= bounds.minX - MARGIN_M && p.x <= bounds.maxX + MARGIN_M
    && p.z >= bounds.minZ - MARGIN_M && p.z <= bounds.maxZ + MARGIN_M;
  const positions: number[] = [], index: number[] = [];
  const pts = river.points;
  let previousKept = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (!inside(p)) { previousKept = false; continue; }
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1, nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
    const w = half + RIVER_TUCK_M, y = p.levelM - RIVER_BELOW_LEVEL_M - CONGO_BASE_M;
    const v = positions.length / 3;
    positions.push(p.x + nx * w, y, p.z + nz * w, p.x - nx * w, y, p.z - nz * w);
    if (previousKept) index.push(v - 2, v - 1, v, v - 1, v + 1, v);
    previousKept = true;
  }
  if (index.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The flood over the flooded forest in the rains: a sheet just over the ground on the 50 m
 * lattice, in the cells within each river's flood belt. Its edge follows the river's course.
 */
function floodSheet(seed: number, bounds: GroundBounds): THREE.BufferGeometry | null {
  const grid = worldGrid(), { near } = riversOf(seed), lattice = congoLattice(seed), origin = -grid.patchM / 2;
  const c0 = Math.round((bounds.minX - origin) / CONGO_STEP_M), r0 = Math.round((bounds.minZ - origin) / CONGO_STEP_M);
  const cols = Math.round((bounds.maxX - bounds.minX) / CONGO_STEP_M), rows = Math.round((bounds.maxZ - bounds.minZ) / CONGO_STEP_M);
  const positions = new Float32Array((cols + 1) * (rows + 1) * 3), index: number[] = [];
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= cols; col++) {
    const o = (row * (cols + 1) + col) * 3, x = origin + (c0 + col) * CONGO_STEP_M, z = origin + (r0 + row) * CONGO_STEP_M;
    positions[o] = x; positions[o + 1] = lattice.vertex(c0 + col, r0 + row) + FLOOD_DEPTH_M; positions[o + 2] = z;
  }
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const x = origin + (c0 + col + 0.5) * CONGO_STEP_M, z = origin + (r0 + row + 0.5) * CONGO_STEP_M;
    const at = near(x, z), half = congoChannelHalfM(at.river, grid);
    // The channel itself carries the river ribbon; the flood stands on the belt beside it.
    if (at.distanceM <= half - CONGO_STEP_M || at.distanceM > half + at.river.floodBeltM) continue;
    const a = row * (cols + 1) + col, b = a + cols + 1;
    index.push(a, b, a + 1, b, b + 1, a + 1);
  }
  if (index.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** Congo 1A.5: the rivers within (and just beyond) the loaded ground, and the flood when `flooded`. */
export function buildCongoWater(seed: number, bounds: GroundBounds, flooded: boolean): THREE.Group {
  const group = new THREE.Group();
  group.name = 'congo-water';
  riversOf(seed).rivers.forEach((river, i) => {
    const geometry = riverRibbon(river, bounds, congoChannelHalfM(river, worldGrid()));
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, waterMaterial(COLOURS[river.kind], 0.94));
    mesh.name = `river:${i}`; mesh.receiveShadow = true;
    group.add(mesh);
  });
  if (flooded) {
    const geometry = floodSheet(seed, bounds);
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, waterMaterial(COLOURS.flood, 0.86));
      mesh.name = 'flood'; mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}
