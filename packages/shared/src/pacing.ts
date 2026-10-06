import type { EncounterTrace } from './encounter.js';
import type { MovementTrace } from './movement.js';

/**
 * Presentation pacing for a recorded hour.
 *
 * The server records routes in world seconds, and the live hour plays back at the world's
 * rate (12 world seconds per real second at 12x). An animal walking a realistic 1 m/s then
 * crossed the screen at 12 m/s, and a gliding vulture at 200 m/s, before standing still for
 * the rest of the hour. Pacing keeps every recorded position, its order and the hour's end,
 * but spends the hour's idle time on the movement, so animals are seen at the pace they
 * move in life. Where an hour holds more movement than fits, it all plays proportionally
 * faster. Nothing here changes the simulation or what was recorded.
 */
const HOUR = 3600;

/** Walking pace on screen, metres per real second. */
const WALK_MPS: Record<string, number> = {
  elephant: 1.4, gaur: 1.3, sambar: 1.4, chital: 1.4, boar: 1.2, tiger: 1.3, dhole: 2.0,
  jackal: 1.6, hare: 1.6, langur: 1.4, squirrel: 1.2, vulture: 12,
};
const RUN_FACTOR = 3.5;
const CLIMB_MPS = 0.8;
const CHASE_MPS = 12;
const STALK_MPS = 1.2;
/**
 * A recorded subdue hold (sim_0.36.0) plays at a quarter of its recorded length in real time
 * (a 20 s nape bite in 5 s, a four-minute throat hold in one minute), never squeezed into idle.
 */
const SUBDUE_SPEEDUP = 4;

export function walkingPace(speciesId: string): number {
  return WALK_MPS[speciesId] ?? 1.4;
}

/** Breakpoints of a monotonic map between the recorded hour and the displayed hour. */
export interface Pacing { trace: number[]; display: number[] }

/**
 * Builds the map from recorded intervals. `intervals` cover [0, 3600] in order; each one is
 * moving (with the display length it needs at least) or idle (slack that can shrink).
 */
export function pace(intervals: Array<{ from: number; to: number; minDisplay: number | null }>): Pacing {
  const moving = intervals.filter((i) => i.minDisplay !== null);
  const need = moving.reduce((sum, i) => sum + Math.max(i.to - i.from, i.minDisplay!), 0);
  const slack = intervals.filter((i) => i.minDisplay === null).reduce((sum, i) => sum + (i.to - i.from), 0);
  const fits = need <= HOUR;
  const slackScale = slack > 0 ? Math.max(0, HOUR - need) / slack : 0;
  const movingScale = fits ? 1 : HOUR / need;
  const trace = [0], display = [0];
  for (const i of intervals) {
    const length = i.minDisplay === null ? (i.to - i.from) * (fits ? slackScale : 0)
      : Math.max(i.to - i.from, i.minDisplay) * movingScale;
    trace.push(i.to);
    display.push(display.at(-1)! + length);
  }
  // Rounding must not leave the hour's end unreachable.
  display[display.length - 1] = HOUR;
  return { trace, display };
}

/** The recorded second shown at a displayed second. */
export function recordedSecondAt(pacing: Pacing, displaySeconds: number): number {
  const { trace, display } = pacing;
  if (!(displaySeconds > 0)) return 0;
  if (displaySeconds >= HOUR) return HOUR;
  let lo = 0, hi = display.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (display[mid]! <= displaySeconds) lo = mid; else hi = mid;
  }
  const span = display[hi]! - display[lo]!;
  const t = span > 0 ? (displaySeconds - display[lo]!) / span : 1;
  return trace[lo]! + (trace[hi]! - trace[lo]!) * t;
}

/** The displayed second at which a recorded second is shown; the inverse of recordedSecondAt. */
export function displaySecondAt(pacing: Pacing, recordedSeconds: number): number {
  return recordedSecondAt({ trace: pacing.display, display: pacing.trace }, recordedSeconds);
}

function withIdleEnds(from: number, to: number, inner: Array<{ from: number; to: number; minDisplay: number | null }>) {
  const intervals: Array<{ from: number; to: number; minDisplay: number | null }> = [];
  if (from > 0) intervals.push({ from: 0, to: from, minDisplay: null });
  intervals.push(...inner);
  if (to < HOUR) intervals.push({ from: to, to: HOUR, minDisplay: null });
  return intervals;
}

/** Pacing for one animal's recorded route at `rate` world seconds per real second. */
export function paceMovement(trace: MovementTrace, speciesId: string, rate: number): Pacing {
  const s = trace.samples;
  const walk = walkingPace(speciesId) * (trace.goal === 'flee' ? RUN_FACTOR : 1);
  const inner = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!, b = s[i]!;
    const ground = Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z);
    const climb = Math.abs((b.altitudeM ?? 0) - (a.altitudeM ?? 0));
    const minDisplay = ground > 0 ? ground / walk * rate : climb > 0 ? climb / CLIMB_MPS * rate : null;
    inner.push({ from: a.seconds, to: b.seconds, minDisplay });
  }
  return pace(withIdleEnds(s[0]!.seconds, s.at(-1)!.seconds, inner));
}

/** Pacing shared by a predator and its prey, so both stay on one timeline. */
export function paceEncounter(trace: EncounterTrace, rate: number): Pacing {
  const s = trace.samples;
  const inner = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!, b = s[i]!;
    const moved = Math.max(Math.hypot(b.predator.x - a.predator.x, b.predator.z - a.predator.z),
      Math.hypot(b.prey.x - a.prey.x, b.prey.z - a.prey.z));
    const fast = a.phase === 'chase' || a.phase === 'escape';
    if (b.phase === 'subdue') { inner.push({ from: a.seconds, to: b.seconds, minDisplay: (b.seconds - a.seconds) / SUBDUE_SPEEDUP * rate }); continue; }
    inner.push({ from: a.seconds, to: b.seconds, minDisplay: moved > 0 ? moved / (fast ? CHASE_MPS : STALK_MPS) * rate : null });
  }
  return pace(withIdleEnds(s[0]!.seconds, s.at(-1)!.seconds, inner));
}
