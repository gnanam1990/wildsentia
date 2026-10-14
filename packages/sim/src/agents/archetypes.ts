import { type Archetype, type GoalId } from '@vana/shared';

/**
 * Which goals each archetype can even consider. Seven entries carry twelve species, and adding
 * a thirteenth species is a config file rather than a code path — which is the whole point of
 * keeping species as data.
 *
 * A goal absent from this list is never scored, so a sambar cannot decide to hunt and a tiger
 * cannot decide to graze, regardless of how hungry either becomes.
 */
export const ARCHETYPE_GOALS: Record<Archetype, readonly GoalId[]> = {
  apex_predator:  ['hunt', 'scavenge', 'find_water', 'rest', 'wander'],
  pack_predator:  ['hunt', 'scavenge', 'find_water', 'rest', 'wander'],
  herd_grazer:    ['flee', 'find_food', 'find_water', 'rest', 'wander'],
  mega_herbivore: ['flee', 'find_food', 'find_water', 'rest', 'wander'],
  omnivore_rooter:['flee', 'scavenge', 'find_food', 'find_water', 'rest', 'wander'],
  arboreal_troop: ['flee', 'find_food', 'find_water', 'rest', 'wander'],
  scavenger_flyer:['scavenge', 'find_water', 'rest', 'wander'],
  // Phase B: a hunter that travels by air and drops onto its prey (the crowned eagle); it
  // 'scavenges' only its own cached kill (perception.ts), feeding on it over days.
  raptor:         ['hunt', 'scavenge', 'find_water', 'rest', 'wander'],
};

export function goalsFor(archetype: Archetype): readonly GoalId[] {
  return ARCHETYPE_GOALS[archetype];
}
