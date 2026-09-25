import { GRID_SIZE, PATCH_COUNT, PATCH_METRES } from './types/patch.js';

/** Server-owned planar position. Ground height still comes from the terrain field. */
export interface WorldPosition { x: number; z: number; heading: number }

export function patchCentre(patchId: number): { x: number; z: number } {
  return { x: (patchId % GRID_SIZE) * PATCH_METRES, z: Math.floor(patchId / GRID_SIZE) * PATCH_METRES };
}

export function spatialHash(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Legacy placement, also the deterministic initial position of an unlocated founder. */
export function subPatchOffset(id: string): { x: number; z: number } {
  const h = spatialHash(id);
  return { x: ((h & 0xffff) / 0xffff - 0.5) * PATCH_METRES * 0.8,
    z: (((h >>> 16) & 0xffff) / 0xffff - 0.5) * PATCH_METRES * 0.8 };
}

export function initialPosition(id: string, patchId: number): WorldPosition {
  const centre = patchCentre(patchId); const offset = subPatchOffset(id);
  return { x: centre.x + offset.x, z: centre.z + offset.z, heading: 0 };
}

export function patchAtPosition(position: WorldPosition): number {
  if (!isWorldPosition(position)) throw new Error('position is outside the world');
  const x = Math.floor((position.x + PATCH_METRES / 2) / PATCH_METRES);
  const z = Math.floor((position.z + PATCH_METRES / 2) / PATCH_METRES);
  return z * GRID_SIZE + x;
}

export function isWorldPosition(value: unknown): value is WorldPosition {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const min = -PATCH_METRES / 2; const max = (GRID_SIZE - 0.5) * PATCH_METRES;
  return typeof p.x === 'number' && Number.isFinite(p.x) && p.x >= min && p.x < max
    && typeof p.z === 'number' && Number.isFinite(p.z) && p.z >= min && p.z < max
    && typeof p.heading === 'number' && Number.isFinite(p.heading) && Math.abs(p.heading) <= Math.PI;
}

export function positionInPatch(value: unknown, patchId: number): value is WorldPosition {
  if (!Number.isInteger(patchId) || patchId < 0 || patchId >= PATCH_COUNT || !isWorldPosition(value)) return false;
  const centre = patchCentre(patchId);
  return value.x >= centre.x - PATCH_METRES / 2 && value.x < centre.x + PATCH_METRES / 2
    && value.z >= centre.z - PATCH_METRES / 2 && value.z < centre.z + PATCH_METRES / 2;
}
