import { GRID_SIZE, PATCH_METRES, patchCentre, positionInPatch, type WorldEvent } from '@vana/shared';

export const MAP_EVENT_TYPES = ['hunt', 'human_hunt', 'born', 'human_born', 'died', 'human_died', 'immigration'] as const;

/** Historical marker coordinates must never be substituted with an animal's current location. */
export function eventMarker(event: WorldEvent) {
  if (!MAP_EVENT_TYPES.includes(event.type as typeof MAP_EVENT_TYPES[number])) return null;
  if (!Number.isInteger(event.patchId) || event.patchId < 0 || event.patchId >= GRID_SIZE ** 2) return null;
  const endpoint = event.type === 'hunt' ? event.encounter?.samples.at(-1)?.prey : undefined;
  const recorded = positionInPatch(event.position, event.patchId) ? event.position : endpoint;
  const exact = recorded && positionInPatch(recorded, event.patchId);
  return {
    id: event.id, type: event.type, worldTime: event.worldTime,
    actorId: event.type === 'human_hunt' && typeof event.conditions.preyId === 'string'
      ? event.conditions.preyId : event.actors[0] ?? null,
    actors: event.actors, outcome: event.outcome, patchId: event.patchId,
    position: exact ? { x: recorded.x, z: recorded.z } : patchCentre(event.patchId),
    precision: exact ? 'recorded' : 'patch',
    label: event.type === 'hunt' ? 'Animal hunt / attack'
      : event.type === 'human_hunt' ? event.outcome === 'success' ? 'Human hunt / catch' : 'Human hunt attempt'
        : event.type === 'born' ? 'Birth' : event.type === 'human_born' ? 'Human birth'
          : event.type === 'human_died' ? 'Human death'
            : event.type === 'immigration' ? event.conditions.route === 'island_crossing' ? 'Arrived across the water' : 'Arrival'
              : 'Death',
    patchMetres: PATCH_METRES,
  };
}
