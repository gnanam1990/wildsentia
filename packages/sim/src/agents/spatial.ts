import { initialPosition, isWorldPosition, positionInPatch, patchCentre, PATCH_METRES, spatialHash,
  type Agent, type Carcass, type WorldPosition } from '@vana/shared';

/** Additive spatial foundation; does not draw RNG or change ecological decisions. */
export function locateAgent(agent: Agent): WorldPosition {
  const previous: unknown = agent.position;
  if (!positionInPatch(agent.position, agent.patchId)) {
    agent.position = initialPosition(agent.id, agent.patchId);
    if (isWorldPosition(previous)) agent.position.heading = Math.atan2(agent.position.x - previous.x, agent.position.z - previous.z);
  }
  return agent.position!;
}

export function locateCarcass(carcass: Carcass): WorldPosition {
  if (!positionInPatch(carcass.position, carcass.patchId)) carcass.position = initialPosition(carcass.originId, carcass.patchId);
  return carcass.position!;
}

/** Resolve a contact anchor on the server. Continuous approach/collision handling is separate. */
export function placeBeside(agent: Agent, target: WorldPosition, radiusM: number): void {
  const angle = spatialHash(agent.id) / 0xffffffff * Math.PI * 2;
  const centre = patchCentre(agent.patchId);
  const limit = PATCH_METRES / 2 - 0.01;
  const clamp = (v: number, c: number): number => Math.max(c - limit, Math.min(c + limit, v));
  const x = clamp(target.x + Math.sin(angle) * radiusM, centre.x);
  const z = clamp(target.z + Math.cos(angle) * radiusM, centre.z);
  agent.position = { x, z, heading: Math.atan2(target.x - x, target.z - z) };
}
