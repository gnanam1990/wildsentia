import { cardinalNeighbours, isFlooded, positionInPatch, spatialHash, waterAccessPosition, type Agent, type Patch, type Season, type WorldGrid,
  type WorldPosition } from '@vana/shared';

/** How far a diver will run to reach water when a predator is on it (one patch, on the lattice). */
const REFUGE_REACH_M = 320;

/**
 * Congo 1B: where a swimmer can dive. Standing in flooded water, right where it is; otherwise
 * the water access point of its own or a neighbouring river patch within reach. Null on dry
 * ground far from water, and for a world with no season (no flooding known).
 */
export function waterRefuge(grid: WorldGrid, agent: Agent, patches: readonly Patch[], season: Season | undefined,
  at: WorldPosition): { patchId: number; position: WorldPosition } | null {
  const here = patches[agent.patchId];
  if (here && (here.flooded === true || (season !== undefined && here.habitat === 'flooded_forest' && isFlooded(here, season)))) return { patchId: here.id, position: { ...at } };
  let best: { patchId: number; position: WorldPosition; d: number } | null = null;
  for (const id of [agent.patchId, ...cardinalNeighbours(grid, agent.patchId)]) {
    const p = patches[id];
    if (!p || p.habitat !== 'water') continue;
    const position = waterAccessPosition(grid, id, patches), d = Math.hypot(position.x - at.x, position.z - at.z);
    if (d <= REFUGE_REACH_M && (!best || d < best.d || (d === best.d && id < best.patchId))) best = { patchId: id, position, d };
  }
  return best && { patchId: best.patchId, position: best.position };
}

/** How far along the bank a diver comes up from where it went under (it swims under water). */
export const SURFACE_SHIFT_M = { min: 15, max: 60 } as const;

/**
 * Back above water: nothing remains of the dive. Given the world (`grid`, `patches`), it comes up
 * 15-60 m from where it went under, in a direction fixed by its id and dive, inside the same
 * patch; at a death, where it is.
 */
export function surface(agent: Agent, grid?: WorldGrid, patches?: readonly Patch[]): void {
  if (grid && patches && agent.position) {
    const h = spatialHash(`surface:${agent.id}:${agent.submergedUntil ?? 0}`);
    const angle = (h & 0xffff) / 0x10000 * 2 * Math.PI;
    const reach = SURFACE_SHIFT_M.min + ((h >>> 16) & 0xffff) / 0xffff * (SURFACE_SHIFT_M.max - SURFACE_SHIFT_M.min);
    for (const scale of [1, 0.5, 0.25]) {
      const at = { x: agent.position.x + Math.sin(angle) * reach * scale, z: agent.position.z + Math.cos(angle) * reach * scale,
        heading: agent.position.heading };
      if (scale < 1 && reach * scale < SURFACE_SHIFT_M.min) break;
      if (positionInPatch(grid, at, agent.patchId)) { agent.position = at; break; }
    }
  }
  delete agent.locomotionMode;
  delete agent.submergedUntil;
}

/** A saved diver: under water until a finite time, at no height, at no tree. */
export function validSubmerged(agent: Agent): boolean {
  return agent.locomotionMode === 'submerged' && Number.isFinite(agent.submergedUntil)
    && agent.altitudeM === undefined && agent.treeAnchorId === undefined;
}
