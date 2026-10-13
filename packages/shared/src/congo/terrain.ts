import { createRng } from '../rng.js';
import { cardinalNeighbours, patchCentre, patchCount, regionIds, regionPatchIds, type WorldGrid } from '../grid.js';
import type { HabitatType } from '../types/patch.js';
import { valueNoise } from './noise.js';
import { CONGO_TERRAIN_VERSION, congoRivers, riverIndex, type RiverPath } from './rivers.js';

/** The Congo forest's ground: one height function and one habitat per patch, from the seed. */
export interface CongoTerrain {
  seed: number; rivers: RiverPath[];
  heightAt(x: number, z: number): number;
  habitatAt(patchId: number): HabitatType;
  /** The kind of river nearest a patch's centre: which channel a water patch belongs to. */
  riverKindAt(patchId: number): RiverPath['kind'];
}

/** Plant capacity (kg per patch) and canopy of each Congo habitat; river channels are `water`. */
export const CONGO_HABITAT_STATS = {
  terra_firme:    { grass: 800,  browse: 7500, canopy: 0.9 },
  flooded_forest: { grass: 2500, browse: 5000, canopy: 0.75 },
  swamp_forest:   { grass: 3000, browse: 2500, canopy: 0.6 },
  bai:            { grass: 8000, browse: 600,  canopy: 0.05 },
  water:          { grass: 0,    browse: 0,    canopy: 0 },
} as const;

export const CONGO_MIN_HEIGHT_M = 250, CONGO_MAX_HEIGHT_M = 700;

const smoothstep = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * The Congo forest's height at any point (congo_terrain_v1), without its habitats: what a browser
 * needs to draw the ground. `createCongoTerrain` uses the same function.
 */
export function congoHeightFn(seed: number, grid: WorldGrid): (x: number, z: number) => number {
  return congoRelief(seed, grid).heightAt;
}

/** A river channel's half-width: at least one patch wide on the lattice, so a 150 m tributary still joins up. */
export function congoChannelHalfM(river: RiverPath, grid: WorldGrid): number {
  return Math.max(river.widthM / 2, grid.patchM * 0.75);
}

function congoRelief(seed: number, grid: WorldGrid) {
  const rivers = congoRivers(seed, grid), nearestRiver = riverIndex(rivers);
  const base = (x: number, z: number): number => CONGO_MIN_HEIGHT_M + 450 * (0.6 * valueNoise(seed, x, z, 12_000, 1)
    + 0.3 * valueNoise(seed, x, z, 4_000, 2) + 0.1 * valueNoise(seed, x, z, 1_200, 3));
  const channelHalf = (r: RiverPath): number => congoChannelHalfM(r, grid);
  const heightAt = (x: number, z: number): number => {
    const near = nearestRiver(x, z), half = channelHalf(near.river);
    if (near.distanceM <= half) return near.levelM - 4;
    const ground = base(x, z), bank = near.levelM + 1;
    const blend = smoothstep(half, half + near.river.floodBeltM + 1_500, near.distanceM);
    return Math.max(CONGO_MIN_HEIGHT_M, Math.min(CONGO_MAX_HEIGHT_M, bank + (Math.max(ground, bank) - bank) * blend));
  };
  return { rivers, nearestRiver, channelHalf, heightAt };
}

export function createCongoTerrain(seed: number, grid: WorldGrid): CongoTerrain {
  const { rivers, nearestRiver, channelHalf, heightAt } = congoRelief(seed, grid);
  const n = patchCount(grid), habitat: HabitatType[] = new Array(n), heights = new Float64Array(n);
  const near = Array.from({ length: n }, (_, id) => { const c = patchCentre(grid, id); return nearestRiver(c.x, c.z); });
  for (let id = 0; id < n; id++) { const c = patchCentre(grid, id); heights[id] = heightAt(c.x, c.z); }
  for (let id = 0; id < n; id++) {
    const c = patchCentre(grid, id), river = near[id]!, half = channelHalf(river.river);
    if (river.distanceM <= half) { habitat[id] = 'water'; continue; }
    if (river.distanceM <= half + river.river.floodBeltM) { habitat[id] = 'flooded_forest'; continue; }
    const around = cardinalNeighbours(grid, id);
    const mean = around.reduce((s, k) => s + heights[k]!, 0) / around.length;
    habitat[id] = heights[id]! <= mean - 6 || valueNoise(seed, c.x, c.z, 9_000, 7) > 0.72 ? 'swamp_forest' : 'terra_firme';
  }
  // One or two bais a region, in dry forest beside wet ground: the clearings animals come to.
  const rng = createRng(seed, CONGO_TERRAIN_VERSION + ':bai');
  for (const region of regionIds(grid)) {
    const candidates = regionPatchIds(grid, region).filter((id) => habitat[id] === 'terra_firme'
      && cardinalNeighbours(grid, id).some((k) => habitat[k] === 'swamp_forest' || habitat[k] === 'flooded_forest'));
    const take = Math.min(candidates.length, 1 + rng.int(2));
    for (let i = 0; i < take; i++) habitat[candidates.splice(rng.int(candidates.length), 1)[0]!] = 'bai';
  }
  return { seed, rivers, heightAt, habitatAt: (id) => habitat[id]!, riverKindAt: (id) => near[id]!.river.kind };
}
