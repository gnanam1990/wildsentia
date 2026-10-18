import { spatialHash } from './spatial.js';
import { habitatAnalogue } from './types/patch.js';
import { CONGO_GRID, patchCentre, patchCount, type WorldGrid } from './grid.js';
import { congoRivers, riverIndex } from './congo/rivers.js';
import { congoChannelHalfM } from './congo/terrain.js';

/** A small authoritative subset of trees, not an inventory of decorative vegetation. */
export interface TreeAnchorGeometry {
  version: 1;
  id: string;
  patchId: number;
  x: number;
  z: number;
  climbHeightM: number;
  /** Where a bird lands: on top of the crown (the Congo's), not inside its leaves. */
  perchHeightM: number;
}

export interface TreeAnchor extends TreeAnchorGeometry {
  visualKind: 'CommonTree_1' | 'TwistedTree_1';
  visualScale: number;
}

export interface TreeAnchorPatch {
  id: number;
  habitat: string;
  canopyCover?: number;
  surface?: 'land' | 'coast' | 'ocean';
  /** A Congo patch's world seed: where its rivers run. */
  congoSeed?: number;
}

/** Rivers by seed and grid, built once: a Congo anchor in a channel has no tree to climb. */
const riversBySeed = new Map<string, ReturnType<typeof riverIndex>>();
export function inCongoChannel(grid: WorldGrid, seed: number, x: number, z: number): boolean {
  const at = congoRiverAt(grid, seed, x, z);
  return at.distanceM <= at.halfM + 3;
}

/** Whether a patch's tree anchor stands in a river's channel: fixed for a world, so found once a patch
 * (it was a fifth of a Congo hour, asked for every neighbour of every monkey up a tree). */
const anchorChannel = { seed: NaN, grid: null as WorldGrid | null, flags: new Uint8Array(0) };
function anchorInChannel(grid: WorldGrid, seed: number, patchId: number, at: { x: number; z: number }): boolean {
  if (anchorChannel.seed !== seed || anchorChannel.grid !== grid) Object.assign(anchorChannel, { seed, grid, flags: new Uint8Array(grid.cols * grid.rows) });
  // 0 unknown, 1 dry, 2 in the channel.
  if (anchorChannel.flags[patchId] === 0) anchorChannel.flags[patchId] = inCongoChannel(grid, seed, at.x, at.z) ? 2 : 1;
  return anchorChannel.flags[patchId] === 2;
}

/** The nearest Congo river to a point: how far its centre line is, and its channel's half-width. */
export function congoRiverAt(grid: WorldGrid, seed: number, x: number, z: number): { distanceM: number; halfM: number } {
  const key = `${seed}:${grid.cols}x${grid.rows}:${grid.patchM}`;
  let near = riversBySeed.get(key);
  if (!near) { near = riverIndex(congoRivers(seed, grid)); riversBySeed.set(key, near); }
  const at = near(x, z);
  return { distanceM: at.distanceM, halfM: congoChannelHalfM(at.river, grid) };
}

/**
 * Stable from a patch's structural habitat, not mutable grass, water or soil state. The
 * corresponding visible tree is placed at this exact planar trunk position by both LODs.
 * The altitude is above local rendered ground; the server never samples client relief.
 */
export function treeAnchorGeometry(grid: WorldGrid, patchId: number): TreeAnchorGeometry | null {
  if (!Number.isInteger(patchId) || patchId < 0 || patchId >= patchCount(grid)) return null;
  const centre = patchCentre(grid, patchId);
  const h = spatialHash(`tree-anchor-v1:${patchId}`);
  const j = spatialHash(`tree-anchor-v1:z:${patchId}`);
  const span = grid.patchM * 0.5, congo = grid.cols === CONGO_GRID.cols && grid.rows === CONGO_GRID.rows;
  return {
    version: 1, id: `tree-v1:${patchId}`, patchId,
    x: centre.x + (h / 0x1_0000_0000 - 0.5) * span,
    z: centre.z + (j / 0x1_0000_0000 - 0.5) * span,
    // The Congo's climbable tree is a canopy tree (trunk to 30 m, limbs 23-30 m, crown 25-34 m, set
    // 0.3 m into the ground: congoPlants.ts): climbers go up among its limbs and a bird lands on
    // top of its crown. The
    // island's is a 6 m one. Each climber goes as high as it does (locomotion.climbHeightM).
    climbHeightM: congo ? 28 : 6,
    perchHeightM: congo ? 34 : 6,
  };
}

/** Forest with trees to climb or perch in: the island's shola and riparian forest, the Congo's
 * terra firme, flooded and swamp forest (swamp forest is the island's marsh in everything else,
 * but it is forest: eagles rested on its floor, the nearest tree 3-6 km away). */
function treedHabitat(habitat: string): boolean {
  const analogue = habitatAnalogue(habitat);
  return analogue === 'shola' || analogue === 'riparian' || habitat === 'swamp_forest';
}

/** New ascent eligibility; geometry remains addressable after canopy loss for safe descent. */
export function treeAnchorForPatch(grid: WorldGrid, patch: TreeAnchorPatch): TreeAnchor | null {
  const geometry = treeAnchorGeometry(grid, patch.id);
  if (!geometry || patch.surface === 'coast' || patch.surface === 'ocean'
    || !(patch.canopyCover !== undefined && Number.isFinite(patch.canopyCover)
      && patch.canopyCover >= 0.3 && patch.canopyCover <= 1)
    || !treedHabitat(patch.habitat)
    // A Congo river may cross a forest patch: no tree stands in its channel.
    || (patch.congoSeed !== undefined && anchorInChannel(grid, patch.congoSeed, patch.id, geometry))) return null;
  return {
    ...geometry,
    visualKind: habitatAnalogue(patch.habitat) === 'shola' ? 'CommonTree_1' : 'TwistedTree_1',
    visualScale: 1.8,
  };
}

/** Why an animal goes up or down its tree, and the goal that move serves: up to escape a ground
 * predator or (a canopy dweller) to rest; down when it is safe, the tree is gone, a need is urgent,
 * or (a canopy dweller) to forage. A canopy dweller also crosses aloft to a neighbouring tree
 * (`traverse`): for fruit and leaves there, or travelling with its troop. Null for any other pairing. */
export function treeClimbGoal(direction: unknown, reason: unknown): 'flee' | 'rest' | 'find_food' | 'wander' | null {
  if (direction === 'ascend') return reason === 'local_threat' ? 'flee' : reason === 'roost' ? 'rest' : null;
  if (direction === 'traverse') return reason === 'canopy_forage' ? 'find_food' : reason === 'canopy_travel' ? 'wander' : null;
  if (direction === 'descend')
    return ['threat_gone', 'canopy_lost', 'urgent_need', 'forage', 'take_cover'].includes(String(reason)) ? 'rest' : null;
  return null;
}

/** A non-climbable standing remnant keeps a previously occupied trunk visible after canopy loss. */
export function treeAnchorRemnantForPatch(grid: WorldGrid, patch: TreeAnchorPatch): TreeAnchorGeometry | null {
  if (patch.surface === 'coast' || patch.surface === 'ocean'
    || !treedHabitat(patch.habitat)
    || patch.canopyCover === undefined || !Number.isFinite(patch.canopyCover)
    || patch.canopyCover < 0 || patch.canopyCover > 1
    || treeAnchorForPatch(grid, patch)) return null;
  return treeAnchorGeometry(grid, patch.id);
}
