import { humanMotionAt, isCommunityMotion, type CommunityState, type CommunityMotion, type LiveEncounterFrame, type HumanAction, type HumanMotionSample, type WorldPosition } from '@vana/shared';

export interface HumanPlaybackPose {
  position: WorldPosition;
  alive: boolean;
  task: { kind: HumanAction; phase: 'travel' | 'work' } | null;
  moving: boolean;
  animationSeconds: number;
}
/** Recorded sample to presentation pose; it never creates or alters a world-state action. */
export function humanPlaybackPose(sample: HumanMotionSample & { moving: boolean }, animationSeconds = sample.seconds): HumanPlaybackPose {
  return { position: sample.position, alive: sample.alive, moving: sample.moving,
    task: sample.action && sample.phase ? { kind: sample.action, phase: sample.phase } : null,
    animationSeconds };
}
/** Shares the committed animal frame's clock, never starts playback on an uncommitted step. */
export class CommunityPlayback {
  #motion: CommunityMotion | null = null;
  #id: string | null = null;
  #receivedAt = 0;
  #elapsed = 0;
  #rate = 0;
  apply(community: CommunityState | null | undefined, frame: LiveEncounterFrame | null, receivedAt: number): void {
    const motion = community?.motion;
    if (!community || !motion || !isCommunityMotion(motion, community) || !frame || !Number.isFinite(receivedAt)
      || !Number.isFinite(frame.rate) || frame.rate <= 0 || !Number.isFinite(frame.elapsedWorldSeconds) || frame.elapsedWorldSeconds < 0
      || frame.elapsedWorldSeconds > 3600 || frame.startWorldTime !== motion.startWorldTime || frame.endWorldTime !== motion.endWorldTime) {
      this.#motion = null; this.#id = null; return;
    }
    this.#elapsed = this.#id === frame.id ? Math.max(this.elapsed(receivedAt), frame.elapsedWorldSeconds) : frame.elapsedWorldSeconds;
    this.#id = frame.id; this.#rate = frame.rate; this.#receivedAt = receivedAt; this.#motion = motion;
  }
  elapsed(now: number): number { return this.#elapsed + Math.max(0, now - this.#receivedAt) * this.#rate / 1000; }
  active(now: number, reducedMotion: boolean): boolean {
    return !reducedMotion && !!this.#motion && Number.isFinite(now) && this.elapsed(now) < this.#motion.endWorldTime - this.#motion.startWorldTime;
  }
  poses(now: number, reducedMotion: boolean): Map<string, HumanPlaybackPose> {
    const result = new Map<string, HumanPlaybackPose>();
    if (!this.active(now, reducedMotion)) return result;
    const seconds = this.elapsed(now);
    for (const track of this.#motion!.tracks) {
      const sample = humanMotionAt(track.samples, seconds);
      result.set(track.personId, humanPlaybackPose(sample, seconds));
    }
    return result;
  }
}
