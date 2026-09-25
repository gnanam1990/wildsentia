import { ISLAND_SEGMENTS, ISLAND_STEP_M, PATCH_METRES, islandVertexHeight } from '@vana/shared';

export interface IslandHeightField {
  readonly seed: number;
  readonly byteLength: number;
  readonly sample: (x: number, z: number) => number;
  vertex(col: number, row: number): number;
}

/** One client-side seed entry, not an ever-growing global terrain cache. Existing consumers
 * may retain their previous field while a new scene prepares; its immutable values stay valid. */
let latest: IslandHeightField | null = null;

export function islandHeightField(seed: number): IslandHeightField {
  if (latest?.seed === seed) return latest;
  const side = ISLAND_SEGMENTS + 1, values = new Float32Array(side * side);
  // The authoritative geology already returns Math.fround values. Float32 storage adds no
  // rounding. Do not approximate, downsample, quantize, or expose this mutable array.
  for (let row = 0; row < side; row++) for (let col = 0; col < side; col++)
    values[row * side + col] = islandVertexHeight(seed, col, row);
  const sample = (x: number, z: number): number => {
    // Preserve islandHeightAt's clamp, triangle split and arithmetic order exactly.
    const gx = Math.max(0, Math.min(ISLAND_SEGMENTS - 1e-9, (x + PATCH_METRES / 2) / ISLAND_STEP_M));
    const gz = Math.max(0, Math.min(ISLAND_SEGMENTS - 1e-9, (z + PATCH_METRES / 2) / ISLAND_STEP_M));
    const col = Math.floor(gx), row = Math.floor(gz), fx = gx - col, fz = gz - row;
    const index = row * side + col;
    const a = values[index]!, b = values[index + side]!, c = values[index + side + 1]!, d = values[index + 1]!;
    return fx + fz <= 1 ? a + (d - a) * fx + (b - a) * fz
      : c + (b - c) * (1 - fx) + (d - c) * (1 - fz);
  };
  latest = Object.freeze({ seed, byteLength: values.byteLength, sample,
    vertex(col: number, row: number): number {
      if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= side || row >= side)
        throw new RangeError('Island vertex outside height field');
      return values[row * side + col]!;
    } });
  return latest;
}
