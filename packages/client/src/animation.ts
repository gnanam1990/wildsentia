/**
 * Maps a server-reported agent state to an animation clip, in order of preference.
 *
 * A model lacking the preferred clip falls back down the list; a model matching nothing gets
 * null, and the caller leaves it on whatever it was playing rather than pretending. An animal
 * must never play a walk cycle while the server says it is grazing — that mismatch between
 * shown behaviour and actual state is the defect this module exists to prevent.
 */
export const CLIP_PREFERENCES: Record<string, readonly string[]> = {
  resting:    ['Idle', 'Idle_2'],
  grazing:    ['Eating', 'Idle_Headlow', 'Idle_2_HeadLow', 'Idle'],
  drinking:   ['Idle_Headlow', 'Idle_2_HeadLow', 'Eating', 'Idle'],
  travelling: ['Walk', 'Gallop', 'Idle'],
  // A stalk is a slow, deliberate walk; a chase and a flight are flat out.
  stalking:   ['Walk', 'Idle'],
  chasing:    ['Gallop', 'Walk', 'Idle'],
  fleeing:    ['Gallop', 'Walk', 'Idle'],
  feeding:    ['Eating', 'Idle_Headlow', 'Idle_2_HeadLow', 'Idle'],
  dead:       ['Death', 'Dead', 'Idle'],
};

const FALLBACK: readonly string[] = ['Idle'];

export function clipForState(state: string, availableClips: readonly string[]): string | null {
  const preferences = CLIP_PREFERENCES[state] ?? FALLBACK;
  for (const wanted of preferences) {
    const match = availableClips.find((clip) => clip.toLowerCase() === wanted.toLowerCase());
    if (match !== undefined) return match;
  }
  return null;
}
