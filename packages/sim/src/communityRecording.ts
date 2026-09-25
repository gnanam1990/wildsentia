import { MAX_HUMAN_MOTION_SAMPLES, humanMotionAt, type CommunityState, type HumanMotionSample, type CommunityMotion, type Person } from '@vana/shared';

/** Observes executed changes only, retaining at most the last hour of a bulk step. */
export class CommunityRecorder {
  readonly #start: number;
  readonly #end: number;
  readonly #tracks = new Map<string, HumanMotionSample[]>();
  readonly #before = new Map<string, HumanMotionSample>();
  #overflow = false;
  constructor(state: CommunityState, startAt: number, seconds: number) {
    this.#end = startAt + seconds; this.#start = Math.max(startAt, this.#end - 3600);
    for (const p of state.people) { this.#tracks.set(p.id, []); this.capture(p, startAt); }
  }
  capture(p: Person, at: number): void {
    if (this.#overflow) return;
    const sample: HumanMotionSample = { seconds: at - this.#start, position: { ...p.position }, alive: p.alive,
      action: p.task?.kind ?? null, phase: p.task?.phase ?? null, taskEventId: p.task?.eventId ?? null };
    if (at < this.#start) { this.#before.set(p.id, sample); return; }
    const samples = this.#tracks.get(p.id);
    if (!samples) return; // A child born mid-recording has no pre-birth track to fabricate.
    if (!samples.length && sample.seconds > 0) {
      const before = this.#before.get(p.id)!;
      // Cut only inside an actual observed straight segment, never across missing route corners.
      const cut = humanMotionAt([before, sample], 0);
      samples.push({ seconds: 0, position: cut.position, alive: cut.alive, action: cut.action, phase: cut.phase, taskEventId: cut.taskEventId });
    }
    const previous = samples.at(-1);
    if (previous && Math.abs(previous.seconds - sample.seconds) < 1e-8) samples[samples.length - 1] = sample;
    else samples.push(sample);
    if (samples.length > MAX_HUMAN_MOTION_SAMPLES) { this.#overflow = true; this.#tracks.clear(); this.#before.clear(); }
  }
  finish(state: CommunityState): CommunityMotion | undefined {
    if (state.people.length !== this.#tracks.size) return undefined;
    for (const p of state.people) this.capture(p, this.#end);
    if (this.#overflow) return undefined; // Never abort or change nature to fit a presentation budget.
    return { version: 1, startWorldTime: this.#start, endWorldTime: this.#end,
      tracks: [...this.#tracks].map(([personId, samples]) => ({ personId, samples })) };
  }
}
