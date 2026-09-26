import * as THREE from 'three';
import { treeAnchorRemnantForPatch } from '@vana/shared';
import { buildTerrain, makeHeightSampler, patchHeight, terrainHeightKey, TERRAIN_LAYERS, type HeightSampler, type PatchView, type TerrainLayer } from './terrain.js';
import { disposeTerrain } from './environment.js';

/** Exact inputs used by each existing terrain draw, not rounded ecological state. Array order
 * is retained because instanced placements use it. Keys are full strings, not collision-prone hashes. */
export function terrainKeys(patches: readonly PatchView[]): Record<TerrainLayer | 'height', string> {
  const seed = patches[0]?.islandSeed;
  const height = terrainHeightKey(patches);
  const land = (p: PatchView) => p.surface === undefined || p.surface === 'land';
  const grass = patches.filter((p) => land(p) && p.grass > 100 && p.habitat !== 'water' && p.water <= 20_000);
  // The same patches terrain.ts draws water for: every positive stock on the island is a pool.
  const water = patches.filter((p) => land(p) && (seed !== undefined
    ? Number.isFinite(p.water) && p.water > 0 : p.habitat === 'water' || p.water > 20_000));
  const trees = JSON.stringify([height, patches.filter((p) => land(p) && ((p.canopyCover ?? 0) >= .3
    || treeAnchorRemnantForPatch(p) !== null)).map((p) => [p.id, treeAnchorRemnantForPatch(p) ? 'remnant' : 'live'])]);
  return {
    height,
    ground: JSON.stringify([height, patches.map((p) => [p.id, p.habitat])]),
    grass: JSON.stringify([height, grass.map((p) => [p.id, Math.min(1, p.grass / 6000)])]),
    water: JSON.stringify([seed === undefined ? 'mainland' : height, water.map((p) => [p.id,
      seed === undefined ? patchHeight(p) : Math.max(2, Math.min(40, Math.sqrt(p.water / 1000 / Math.PI)))]),
      patches.filter((p) => p.drainage !== undefined).map((p) => [p.id, p.drainage?.downstreamPatchId,
        p.drainage?.outflowL, p.drainage?.inflowL])]),
    rock: JSON.stringify([height, patches.filter((p) => land(p) && p.habitat === 'rock').map((p) => p.id)]),
    trunk: trees, canopy: trees, ocean: seed === undefined ? 'absent' : 'island',
  };
}

export interface PreparedTerrain { readonly root: THREE.Group; readonly height: HeightSampler }
interface OwnedTerrain extends PreparedTerrain { keys: ReturnType<typeof terrainKeys> }
interface Preparation { base: OwnedTerrain | null; next: OwnedTerrain; reuse: TerrainLayer[] }

/** One committed scene plus pending changed layers. Preparation/discard never detaches or
 * disposes active objects. Only commit reparents reusable layers; each resource has one owner. */
export class TerrainCheckpoints {
  #current: OwnedTerrain | null = null;
  readonly #pending = new Map<PreparedTerrain, Preparation>();
  #disposed = false;

  prepare(patches: readonly PatchView[]): PreparedTerrain {
    if (this.#disposed) throw new Error('Terrain checkpoints disposed');
    const keys = terrainKeys(patches), base = this.#current;
    const changed = new Set(TERRAIN_LAYERS.filter((name) => !base || keys[name] !== base.keys[name]));
    const next: OwnedTerrain = { keys, root: buildTerrain(patches, changed),
      height: base?.keys.height === keys.height ? base.height : makeHeightSampler(patches) };
    const result: PreparedTerrain = { root: next.root, height: next.height };
    this.#pending.set(result, { base, next, reuse: TERRAIN_LAYERS.filter((name) => !changed.has(name)) });
    return result;
  }

  commit(prepared: PreparedTerrain): THREE.Group {
    const state = this.#pending.get(prepared);
    if (!state || state.base !== this.#current || this.#disposed) throw new Error('Stale or unknown terrain preparation');
    const { base, next, reuse } = state;
    for (const name of reuse) {
      const object = base?.root.getObjectByName(name);
      if (object) next.root.add(object);
    }
    // Reused objects have moved; only replaced resources remain in the old root.
    if (base) { base.root.removeFromParent(); disposeTerrain(base.root); base.root.clear(); }
    this.#current = next; this.#pending.delete(prepared);
    return next.root;
  }

  discard(prepared: PreparedTerrain): void {
    const state = this.#pending.get(prepared);
    if (!state) return;
    this.#pending.delete(prepared);
    disposeTerrain(state.next.root); state.next.root.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const prepared of this.#pending.keys()) this.discard(prepared);
    if (this.#current) {
      this.#current.root.removeFromParent(); disposeTerrain(this.#current.root); this.#current.root.clear();
      this.#current = null;
    }
  }
}
