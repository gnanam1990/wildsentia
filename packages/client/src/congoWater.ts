import * as THREE from 'three';
import { congoChannelHalfM, congoRivers, riverIndex, type RiverPath } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
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

const COLOURS = { main: 0x7d6444, tributary: 0x4a3a26, flood: 0x3a3020 } as const;

let riverCache: { seed: number; rivers: RiverPath[]; near: ReturnType<typeof riverIndex> } | null = null;
function riversOf(seed: number): NonNullable<typeof riverCache> {
  if (riverCache?.seed !== seed) { const rivers = congoRivers(seed, worldGrid()); riverCache = { seed, rivers, near: riverIndex(rivers) }; }
  return riverCache;
}

let ripples: THREE.Texture | null | undefined;
/** Small wind ripples as a normal map, drawn once on a canvas (none outside a browser). */
function rippleNormals(): THREE.Texture | null {
  if (ripples !== undefined) return ripples;
  if (typeof document === 'undefined') return ripples = null;
  const size = 128, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return ripples = null;
  const h = (x: number, y: number) => Math.sin(x * 0.29 + Math.sin(y * 0.11) * 2) * 0.5 + Math.sin(y * 0.37 + x * 0.07) * 0.35
    + Math.sin((x + y) * 0.53) * 0.15;
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1), o = (y * size + x) * 4;
    image.data[o] = 128 + dx * 90; image.data[o + 1] = 128 + dy * 90; image.data[o + 2] = 255; image.data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return ripples = texture;
}

function waterMaterial(colour: number, opacity: number): THREE.MeshStandardMaterial {
  const normalMap = rippleNormals();
  return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.06, metalness: 0.25, transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
    ...(normalMap ? { normalMap, normalScale: new THREE.Vector2(0.35, 0.35) } : {}) });
}

/** Texture coordinates from world position: one ripple tile every 24 m wherever the water is. */
function worldUv(geometry: THREE.BufferGeometry): void {
  const p = geometry.getAttribute('position'), uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / 24; uv[i * 2 + 1] = p.getZ(i) / 24; }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** One river's course within the bounds, as a ribbon as wide as its channel at the river's own level. */
function riverRibbon(river: RiverPath, ground: LoadedGround, half: number): THREE.BufferGeometry | null {
  const loaded = (x: number, z: number) => ground.regions.has(regionKey(x, z));
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
    if (previousKept) index.push(v - 2, v - 1, v, v - 1, v + 1, v);
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

/** Congo 1A.5: the rivers within (and just beyond) the loaded ground, and the flood when `flooded`. */
export function buildCongoWater(seed: number, bounds: LoadedGround, flooded: boolean): THREE.Group {
  const group = new THREE.Group();
  group.name = 'congo-water';
  riversOf(seed).rivers.forEach((river, i) => {
    const geometry = riverRibbon(river, bounds, congoChannelHalfM(river, worldGrid()));
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

/** The region (`col,row`) a point lies in. */
function regionKey(x: number, z: number): string {
  const grid = worldGrid(), span = grid.regionPatches * grid.patchM, origin = -grid.patchM / 2;
  return `${Math.floor((x - origin) / span)},${Math.floor((z - origin) / span)}`;
}
