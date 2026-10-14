import { spatialHash } from './spatial.js';
import { habitatAnalogue } from './types/patch.js';
import { patchCentre, patchCount, type WorldGrid } from './grid.js';
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
function inCongoChannel(grid: WorldGrid, seed: number, x: number, z: number): boolean {
  const key = `${seed}:${grid.cols}x${grid.rows}:${grid.patchM}`;
  let near = riversBySeed.get(key);
  if (!near) { near = riverIndex(congoRivers(seed, grid)); riversBySeed.set(key, near); }
  const at = near(x, z);
  return at.distanceM <= congoChannelHalfM(at.river, grid) + 3;
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
  const span = grid.patchM * 0.5;
  return {
    version: 1, id: `tree-v1:${patchId}`, patchId,
    x: centre.x + (h / 0x1_0000_0000 - 0.5) * span,
    z: centre.z + (j / 0x1_0000_0000 - 0.5) * span,
    climbHeightM: 6,
  };
}

/** New ascent eligibility; geometry remains addressable after canopy loss for safe descent. */
export function treeAnchorForPatch(grid: WorldGrid, patch: TreeAnchorPatch): TreeAnchor | null {
  const geometry = treeAnchorGeometry(grid, patch.id);
  if (!geometry || patch.surface === 'coast' || patch.surface === 'ocean'
    || !(patch.canopyCover !== undefined && Number.isFinite(patch.canopyCover)
      && patch.canopyCover >= 0.3 && patch.canopyCover <= 1)
    || (habitatAnalogue(patch.habitat) !== 'shola' && habitatAnalogue(patch.habitat) !== 'riparian')
    // A Congo river may cross a forest patch: no tree stands in its channel.
    || (patch.congoSeed !== undefined && inCongoChannel(grid, patch.congoSeed, geometry.x, geometry.z))) return null;
  return {
    ...geometry,
    visualKind: habitatAnalogue(patch.habitat) === 'shola' ? 'CommonTree_1' : 'TwistedTree_1',
    visualScale: 1.8,
  };
}

/** A non-climbable standing remnant keeps a previously occupied trunk visible after canopy loss. */
export function treeAnchorRemnantForPatch(grid: WorldGrid, patch: TreeAnchorPatch): TreeAnchorGeometry | null {
  if (patch.surface === 'coast' || patch.surface === 'ocean'
    || (habitatAnalogue(patch.habitat) !== 'shola' && habitatAnalogue(patch.habitat) !== 'riparian')
    || patch.canopyCover === undefined || !Number.isFinite(patch.canopyCover)
    || patch.canopyCover < 0 || patch.canopyCover > 1
    || treeAnchorForPatch(grid, patch)) return null;
  return treeAnchorGeometry(grid, patch.id);
}
