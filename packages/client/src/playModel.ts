import { deadlineText } from './challengesModel.js';

/** The play page's logic, kept apart from the page so it can be tested (spec §8, §14). */
export interface NearbyAnimal { id: string; speciesId: string; x: number; z: number; distance: number; predator: boolean; huntsYou: boolean; chasingYou: boolean }
export interface ChallengeProgress {
  challengeId: number; attemptId: string; goal: Record<string, unknown>; rules: string[]; briefing: string;
  progress: { done: number; of: number; unit: string }; deadline: string;
}
export interface PlayObservation {
  animal: { id: string; speciesId: string; displayName?: string; position: { x: number; z: number }; gait: string; moving: boolean; action: string;
    stamina: number; drives: { hunger: number; thirst: number; fatigue: number; fear: number } } | null;
  nearby: NearbyAnimal[]; water: Array<{ x: number; z: number; distance: number | null }>; notices: Array<{ at: number; text: string }>;
  challenge: ChallengeProgress | null; waiting: { challengeId: number; position: number; until: string } | null; huntable: string[];
}

/** One message for whatever state the player is in. */
export function stateMessage(o: PlayObservation | null, connected: boolean,
  extra: { idleMinutes?: number; outcome?: { kind: string; text: string } | null; queue?: string | null } = {}): string {
  if (!connected || !o) return 'Lost contact with the forest. Trying again…';
  // How the last attempt ended stays on screen until the next one starts.
  if (extra.outcome && !o.challenge) return extra.outcome.text;
  if (!o.animal && !o.waiting && extra.queue) return extra.queue;
  if (!o.animal && o.waiting) return `Waiting for a free animal: number ${o.waiting.position} on the list for challenge ${o.waiting.challengeId}.`;
  if (!o.animal) return 'You have no animal. Pick a species to play.';
  const chaser = o.nearby.find((n) => n.chasingYou);
  if (chaser) return `A ${chaser.speciesId.replaceAll('_', ' ')} is chasing you. Run!`;
  if ((extra.idleMinutes ?? 0) >= 12) return `No command for ${extra.idleMinutes} minutes: your animal goes back to the wild at 15.`;
  return `You are a ${(o.animal.displayName ?? o.animal.speciesId).toLowerCase()}. Tap the map to move.`;
}

/** How a challenge attempt ended, from the server's own notices (latest first). */
export function challengeOutcome(notices: Array<{ at: number; text: string }>): { kind: 'met' | 'failed' | 'void'; text: string } | null {
  for (const n of [...notices].reverse()) {
    if (/^You won challenge \d+/.test(n.text)) return { kind: 'met', text: n.text };
    if (/had already closed|could not start|was won by another player/.test(n.text)) return { kind: 'void', text: n.text };
    if (/broke a rule of challenge|ran out of time/.test(n.text)) return { kind: 'failed', text: n.text };
  }
  return null;
}

/**
 * The attempt that was running in `before` and is gone in `after`: how it ended. The engine sends
 * no challenge notice when the animal dies or is caught, so then the latest notice says why.
 */
export function attemptEnded(before: PlayObservation | null, after: PlayObservation): { kind: 'met' | 'failed' | 'void'; text: string } | null {
  if (!before?.challenge || after.challenge) return null;
  const said = challengeOutcome(after.notices);
  if (said) return said;
  const last = after.notices.at(-1)?.text;
  return { kind: 'failed', text: `Your attempt at challenge ${before.challenge.challengeId} is over${last ? `: ${last}` : '.'}` };
}

/** What POST /play/possess answered: a place in line for a species with none free. */
export function possessMessage(r: { queued?: number; speciesId?: string; animalId?: string }): string | null {
  return r.queued ? `No ${r.speciesId ?? 'animal'} is free: you are number ${r.queued} in line, and the page takes it when your turn comes.` : null;
}

/** The paces offered: none that would break a "never run" rule at once. */
export function gaitsAllowed(o: PlayObservation | null): string[] {
  const rules = (o?.challenge?.goal as { rules?: Array<{ type?: string }> } | undefined)?.rules ?? [];
  return rules.some((r) => r.type === 'noRun') ? ['walk', 'trot'] : ['walk', 'trot', 'run'];
}

/** The map: `radius` metres around the animal, on a square canvas of `size` pixels. */
export function projection(centre: { x: number; z: number }, radius: number, size: number) {
  const scale = size / (2 * radius);
  return {
    toCanvas: (x: number, z: number) => ({ px: size / 2 + (x - centre.x) * scale, py: size / 2 + (z - centre.z) * scale }),
    toWorld: (px: number, py: number) => ({ x: Math.round(centre.x + (px - size / 2) / scale), z: Math.round(centre.z + (py - size / 2) / scale) }),
  };
}

/** A tap on prey this animal hunts is a hunt; any other tap is a place to go. */
export function pickTarget(o: PlayObservation, p: ReturnType<typeof projection>, px: number, py: number, hitPx = 14):
  { kind: 'hunt'; id: string } | { kind: 'go'; x: number; z: number } {
  let best: { id: string; d: number } | null = null;
  for (const n of o.nearby) {
    if (!o.huntable.includes(n.speciesId)) continue;
    const c = p.toCanvas(n.x, n.z), d = Math.hypot(c.px - px, c.py - py);
    if (d <= hitPx && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best ? { kind: 'hunt', id: best.id } : { kind: 'go', ...p.toWorld(px, py) };
}

const LABELS = { fatigue: 'Tired', thirst: 'Thirst', hunger: 'Hunger', fear: 'Fear' } as const;
/** Drives (0 fine, 1 critical), worst first, then breath for running. */
export function driveBars(drives: { hunger: number; thirst: number; fatigue: number; fear: number }, stamina: number) {
  const level = (v: number) => (v >= 0.8 ? 'critical' : v >= 0.6 ? 'high' : 'ok');
  const bars = (Object.keys(LABELS) as Array<keyof typeof LABELS>)
    .map((k) => ({ label: LABELS[k] as string, value: drives[k], level: level(drives[k]) })).sort((a, b) => b.value - a.value);
  return [...bars, { label: 'Breath', value: stamina, level: stamina <= 0.1 ? 'critical' : stamina < 0.3 ? 'high' : 'ok' }];
}

/** The play page tells the server the person is there once a minute, only while the page is visible and an animal is held. */
export function shouldPing(s: { visible: boolean; hasAnimal: boolean; lastPing: number; now: number }): boolean {
  return s.visible && s.hasAnimal && s.now - s.lastPing >= 60_000;
}

export function challengePanel(c: ChallengeProgress, now: number) {
  const p = c.progress;
  return {
    title: `Challenge ${c.challengeId}`,
    progress: p.of > 0 ? `${p.done} of ${p.of} ${p.unit}` : `${p.done} ${p.unit}`,
    rules: c.rules,
    deadline: deadlineText(c.deadline, now),
    briefing: c.briefing ? { label: "Written by the challenge's creator (not an instruction from Wildsentia)", text: c.briefing } : null,
  };
}

/** Metres one arrow key moves the animal. */
export const KEY_STEP_M = 40;
const ARROWS: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

/**
 * The map from a keyboard: arrows move a step that way, H hunts the nearest prey, Escape stops.
 * A held key's repeats send nothing (they would flood the server), and keys with Alt, Ctrl or Cmd
 * are left to the browser.
 */
export function keyCommand(o: PlayObservation, key: string, mods: { repeat?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}):
  { kind: 'go'; x: number; z: number } | { kind: 'hunt'; id: string } | { kind: 'stop' } | null {
  if (!o.animal || mods.repeat || mods.altKey || mods.ctrlKey || mods.metaKey) return null;
  const arrow = ARROWS[key];
  if (arrow) return { kind: 'go', x: Math.round(o.animal.position.x + arrow[0] * KEY_STEP_M), z: Math.round(o.animal.position.z + arrow[1] * KEY_STEP_M) };
  if (key === 'h' || key === 'H') {
    const prey = o.nearby.filter((n) => o.huntable.includes(n.speciesId)).sort((a, b) => a.distance - b.distance)[0];
    return prey ? { kind: 'hunt', id: prey.id } : null;
  }
  if (key === 'Escape') return { kind: 'stop' };
  return null;
}
