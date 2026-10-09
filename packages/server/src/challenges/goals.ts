import { REACH_WITHIN_M, type ChallengeTerms } from './terms.js';

/** A forest day in world seconds. */
export const WORLD_DAY_SECONDS = 86_400;

/** What an attempt has done so far: counted from live hunts, the world clock and where the animal is. */
export interface AttemptProgress {
  /** World time (seconds) when the attempt's animal was taken. */
  startedWorld: number;
  /** Kills the player's predator made in live hunts. */
  kills: number;
  /** Live hunts on the player's animal that it survived. */
  escapes: number;
  /** Where the animal is now (for a reach goal). */
  position?: { x: number; z: number } | null;
}

/** How far along the goal is, for the player and for spectators. */
export function progressOf(terms: ChallengeTerms, p: AttemptProgress, worldNow: number): { done: number; of: number; unit: string } {
  switch (terms.template) {
    case 'survive': {
      const days = Math.max(0, worldNow - p.startedWorld) / WORLD_DAY_SECONDS;
      return { done: Math.min(terms.days, Math.floor(days * 100) / 100), of: terms.days, unit: 'days' };
    }
    case 'hunt': return { done: Math.min(terms.count, p.kills), of: terms.count, unit: 'kills' };
    case 'escape': return { done: Math.min(terms.count, p.escapes), of: terms.count, unit: 'escapes' };
    case 'reach': {
      const left = p.position ? Math.hypot(p.position.x - terms.x, p.position.z - terms.z) : Number.NaN;
      return { done: Number.isFinite(left) ? Math.round(left) : 0, of: 0, unit: 'metres to go' };
    }
  }
}

/** True once the attempt has met its goal. The animal must still be the player's; the engine checks that. */
export function goalMet(terms: ChallengeTerms, p: AttemptProgress, worldNow: number): boolean {
  switch (terms.template) {
    case 'survive': return worldNow - p.startedWorld >= terms.days * WORLD_DAY_SECONDS;
    case 'hunt': return p.kills >= terms.count;
    case 'escape': return p.escapes >= terms.count;
    case 'reach': return !!p.position && Math.hypot(p.position.x - terms.x, p.position.z - terms.z) <= REACH_WITHIN_M;
  }
}
