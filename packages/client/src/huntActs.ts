/**
 * What predator and prey are doing at a moment of a recorded hunt, for their poses.
 *
 * A kill is not a touch. The hunter springs the last metres (pounce), seizes the prey and holds
 * it by the throat or nape (holding); the prey is struck, staggers, goes down and struggles
 * (struck, falling, struggling) until it dies, then lies still while the hunter feeds.
 *
 * Timing comes from the recording: contact is the first 'contact' sample, and the death is the
 * end of the recorded 'subdue' phase. Hunts recorded before that phase existed died at contact,
 * so for them the prey collapses from the moment of contact, as recorded. Poses are
 * illustrative; positions, timing and outcome are the simulation's.
 */
import type { EncounterTrace } from '@vana/shared';

/** The spring onto the prey, in real seconds before contact. */
export const POUNCE_S = 0.7;
/** The prey's stagger as it is seized, then its fall to the ground. */
export const STRUCK_S = 0.45;
export const FALL_S = 1.0;
/** A hunter keeps its grip a little after the prey goes still before it starts to feed. */
export const HOLD_AFTER_S = 1.5;
/** States drawn from a hunt's acts rather than from movement. */
export const ACT_STATES = new Set(['pouncing', 'holding', 'struck', 'falling', 'struggling']);

export interface HuntAct {
  state: string;
  /** Real seconds since this act began, for one-shot clips. */
  act?: number;
  /** Struggle strength, 1 when first pulled down, fading as the prey weakens. */
  weight?: number;
}
export interface HuntMoment { predator: HuntAct; prey: HuntAct; facePrey: boolean }

/** A replayed kill runs on past the recorded death: the collapse, the grip, the first of the feed. */
export const AFTERMATH_S = FALL_S + HOLD_AFTER_S + 2.5;

/** How long a recorded hunt's replay runs, in recorded seconds. */
export function huntReplaySeconds(trace: EncounterTrace, outcome: string): number {
  return trace.samples.at(-1)!.seconds + (outcome === 'success' ? AFTERMATH_S : 0);
}

export function contactSeconds(trace: EncounterTrace): number | null {
  return trace.samples.find((s) => s.phase === 'contact')?.seconds ?? null;
}

/** The recorded death: the end of the hold, or contact for hunts recorded without one. */
export function deathSeconds(trace: EncounterTrace, outcome: string): number | null {
  if (outcome !== 'success') return null;
  const subdue = trace.samples.filter((s) => s.phase === 'subdue');
  return subdue.length ? subdue.at(-1)!.seconds : contactSeconds(trace);
}

/**
 * @param seconds recorded seconds into the hunt
 * @param moving whether each actor is moving at this moment, and the recorded phase
 * @param since real seconds elapsed since a recorded second (negative before it)
 */
export function huntMoment(trace: EncounterTrace, outcome: string, seconds: number,
  at: { phase: string; predatorMoving: boolean; preyMoving: boolean; finished: boolean },
  since: (recordedSeconds: number) => number): HuntMoment {
  const contact = contactSeconds(trace), death = deathSeconds(trace, outcome);
  const held = trace.samples.some((s) => s.phase === 'subdue');
  const fromContact = contact === null ? null : since(contact);

  let predator: HuntAct = { state: at.predatorMoving ? at.phase === 'chase' ? 'chasing' : 'stalking' : 'resting' };
  let prey: HuntAct = { state: at.finished && outcome === 'success' ? 'dead' : at.preyMoving ? 'fleeing' : 'resting' };
  let facePrey = false;

  if (fromContact !== null && fromContact < 0 && fromContact >= -POUNCE_S) {
    predator = { state: 'pouncing', act: POUNCE_S + fromContact };
    facePrey = true;
  }
  if (fromContact !== null && fromContact >= 0) {
    if (outcome === 'success' && death !== null) {
      const afterDeath = since(death);
      if (afterDeath < HOLD_AFTER_S || (!held && fromContact < HOLD_AFTER_S + FALL_S)) {
        predator = { state: 'holding', act: fromContact };
        facePrey = true;
      } else predator = { state: 'feeding' };
      if (!held) {
        // Recorded dead at contact: the collapse is its dying, played from that moment.
        prey = fromContact < FALL_S ? { state: 'falling', act: fromContact } : { state: 'dead' };
      } else if (seconds < death) {
        if (fromContact < STRUCK_S) prey = { state: 'struck', act: fromContact };
        else if (fromContact < STRUCK_S + FALL_S) prey = { state: 'falling', act: fromContact - STRUCK_S };
        else {
          const left = Math.max(0, Math.min(1, (death - seconds) / Math.max(1e-6, death - contact!)));
          prey = { state: 'struggling', act: fromContact - STRUCK_S - FALL_S, weight: 0.2 + 0.8 * left };
        }
      } else prey = { state: 'dead' };
    } else if (held && seconds < trace.samples.filter((s) => s.phase === 'subdue').at(-1)!.seconds) {
      // Seized and held, but it broke free (sim_0.36): it fights the grip on its feet, staggering
      // again and again, then runs as recorded. It is never shown down or dead.
      predator = { state: 'holding', act: fromContact };
      prey = { state: 'struck', act: fromContact % (STRUCK_S * 2) };
      facePrey = true;
    } else if (fromContact < STRUCK_S) {
      // Seized but not killed: struck, then running again as recorded.
      prey = { state: 'struck', act: fromContact };
    }
  }
  return { predator, prey, facePrey };
}
