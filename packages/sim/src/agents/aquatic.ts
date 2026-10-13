import { cardinalNeighbours, isFlooded, waterAccessPosition, type Agent, type Patch, type Season, type WorldGrid,
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
  if (here && season && isFlooded(here, season) && here.habitat !== 'water') return { patchId: here.id, position: { ...at } };
  let best: { patchId: number; position: WorldPosition; d: number } | null = null;
  for (const id of [agent.patchId, ...cardinalNeighbours(grid, agent.patchId)]) {
    const p = patches[id];
    if (!p || p.habitat !== 'water') continue;
    const position = waterAccessPosition(grid, id, patches), d = Math.hypot(position.x - at.x, position.z - at.z);
    if (d <= REFUGE_REACH_M && (!best || d < best.d || (d === best.d && id < best.patchId))) best = { patchId: id, position, d };
  }
  return best && { patchId: best.patchId, position: best.position };
}

/** Back above water: nothing remains of the dive. */
export function surface(agent: Agent): void {
  delete agent.locomotionMode;
  delete agent.submergedUntil;
}

/** A saved diver: under water until a finite time, at no height, at no tree. */
export function validSubmerged(agent: Agent): boolean {
  return agent.locomotionMode === 'submerged' && Number.isFinite(agent.submergedUntil)
    && agent.altitudeM === undefined && agent.treeAnchorId === undefined;
}
