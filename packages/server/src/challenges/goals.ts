import type { ChallengeTerms } from './terms.js';

/** A forest day in world seconds. */
export const WORLD_DAY_SECONDS = 86_400;

/** What an attempt has done so far: counted from live hunts and the world clock. */
export interface AttemptProgress {
  /** World time (seconds) when the attempt's animal was taken. */
  startedWorld: number;
  /** Kills the player's predator made in live hunts. */
  kills: number;
  /** Live hunts on the player's animal that it survived. */
  escapes: number;
}

/** How far along the goal is, for the player and for spectators. */
export function progressOf(terms: ChallengeTerms, p: AttemptProgress, worldNow: number): { done: number; of: number; unit: string } {
  switch (terms.template) {
    case 'survive': {
      const days = Math.max(0, worldNow - p.startedWorld) / WORLD_DAY_SECONDS;
      return { done: Math.min(terms.days, Math.floor(days * 100) / 100), of: terms.days, unit: 'days' };
    }
    case 'hunt': return { done: Math.min(1, p.kills), of: 1, unit: 'kills' };
    case 'escape': return { done: Math.min(terms.count, p.escapes), of: terms.count, unit: 'escapes' };
  }
}

/** True once the attempt has met its goal. The animal must still be the player's; the engine checks that. */
export function goalMet(terms: ChallengeTerms, p: AttemptProgress, worldNow: number): boolean {
  switch (terms.template) {
    case 'survive': return worldNow - p.startedWorld >= terms.days * WORLD_DAY_SECONDS;
    case 'hunt': return p.kills >= 1;
    case 'escape': return p.escapes >= terms.count;
  }
}
