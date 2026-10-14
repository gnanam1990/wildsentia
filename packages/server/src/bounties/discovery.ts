import { daylightAt, perceive, windAt } from './perception.js';

interface ActiveBounty { bountyId: string; targetAnimalId: string; targetSpeciesId?: string; speciesId?: string; amountAtomic: bigint; decimals: number; deadlineWorldTime: number | null }
interface DiscoveryStore {
  active(): Promise<ActiveBounty[]>;
  recordEntrant(bountyId: string, agentId: string, animalId: string, worldTime: number): Promise<boolean>;
  /** The track log's store, so a restart does not wipe a trail (optional: tests may keep it in memory). */
  saveTrack?(s: TrackSample & { bountyId: string }): Promise<void>;
  tracks?(bountyId: string, since: number): Promise<Array<TrackSample & { bountyId: string }>>;
}
export interface Sensed { id: string; x: number; z: number; moving: boolean; running: boolean }

/**
 * How an animal is moving now: a steered one by its avatar (the sim's state stays 'resting' while
 * an agent steers it), one in a live chase by its runner, else by the sim's last state.
 */
export function motionOf(animal: { state: string }, runner: { mode: string } | null | undefined,
  avatar: { moving: boolean; gait: string } | null | undefined): { moving: boolean; running: boolean } {
  if (avatar) return { moving: avatar.moving, running: avatar.moving && avatar.gait === 'run' };
  if (runner && runner.mode !== 'idle') return { moving: true, running: true };
  return { moving: ['travelling', 'fleeing', 'chasing', 'stalking'].includes(animal.state),
    running: animal.state === 'fleeing' || animal.state === 'chasing' };
}
/**
 * What a target is doing, for its track log: a live chase or flight; a steered sprint calls as a
 * wild one would (prey flee, the leopard chases); a steered walk travels; else its own state.
 */
export function targetState(animal: { speciesId: string; state: string }, runner: { mode: string } | null | undefined,
  avatar: { moving: boolean; gait: string } | null | undefined): string {
  if (runner?.mode === 'flee') return 'fleeing';
  if (runner?.mode === 'chase') return 'chasing';
  if (avatar) return !avatar.moving ? 'resting' : avatar.gait === 'run' ? (animal.speciesId === 'african_leopard' ? 'chasing' : 'fleeing') : 'travelling';
  return animal.state;
}
export interface BountyFlag { bountyId: string; amountAtomic: string; decimals: number; timeLeftWorldSeconds: number }

/** Where a bounty's target was, and what it was doing: one entry of its sampled track log. */
interface TrackSample { x: number; z: number; state: string; worldTime: number }

/**
 * A clue to a bounty's target from what it really did (spec §6): its fresh tracks near the agent's
 * animal (where, how old, which way it went), a call heard (a bearing and a rough distance only),
 * or disturbance in the patch the animal stands in. Never the target's animal id.
 */
export interface Clue {
  kind: 'tracks' | 'call' | 'disturbance'; bountyId: string; speciesId?: string; ageWorldSeconds: number;
  x?: number; z?: number; headingDeg?: number; bearingDeg?: number; distance?: 'near' | 'far';
}

/** Tracks fade after four world hours and are read within 30 m; a call carries 400 m and is news
 * for a quarter of an hour; a patch shows disturbance for two hours. The log keeps six hours. */
const TRACKS_FADE_S = 4 * 3600, TRACK_RADIUS_M = 30, CALL_RECENT_S = 15 * 60, EARSHOT_M = 400, CALL_NEAR_M = 150;
const DISTURBANCE_S = 2 * 3600, LOG_KEEP_S = 6 * 3600, LOG_MAX = 600;
/** A track or a disturbed patch is a clue only once the target has left it, five world minutes
 * ago or more: where the target is now is found by sensing it, never handed over as a clue. */
const LEFT_BEHIND_S = 5 * 60;
/** States in which an animal calls: prey give alarm calls when they flee, a predator in a chase. */
const CALLING = new Set(['fleeing', 'chasing']);
const degrees = (dx: number, dz: number) => ((Math.round(Math.atan2(dx, dz) * 180 / Math.PI) % 360) + 360) % 360;

/**
 * Congo 1D (spec §6): what each agent's animal perceives, and the bounty it learns of that way.
 * Only sensed animals are listed; a sensed bounty target carries its bounty; once out of sense,
 * only its last-seen position and time remain. The first sighting enters the agent.
 */
export class BountyDiscovery {
  #byTarget = new Map<string, ActiveBounty>();
  #lastSeen = new Map<string, Map<string, { x: number; z: number; worldTime: number }>>();
  #entered = new Set<string>();
  #tracks = new Map<string, TrackSample[]>();
  #loaded = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: DiscoveryStore, private readonly worldId: () => string) {}

  /**
   * Reloads the active bounties (a timer calls this every few seconds), and the saved track log of
   * any bounty whose log is not yet in memory (after a restart), from `worldTime` back six hours.
   */
  async refresh(worldTime?: number): Promise<void> {
    // Held bounties are not on offer: no agent is told of them.
    const active = (await this.store.active()).filter((b) => (b as { status?: string }).status === undefined || (b as { status?: string }).status === 'active');
    this.#byTarget = new Map(active.map((b) => [b.targetAnimalId, b]));
    const live = new Set(active.map((b) => b.bountyId));
    for (const seen of this.#lastSeen.values()) for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
    for (const id of [...this.#tracks.keys()]) if (!live.has(id)) this.#tracks.delete(id);
    for (const id of [...this.#loaded]) if (!live.has(id)) this.#loaded.delete(id);
    if (this.store.tracks) for (const b of active) {
      if (this.#loaded.has(b.bountyId)) continue;
      this.#loaded.add(b.bountyId);
      const saved = await this.store.tracks(b.bountyId, worldTime === undefined ? 0 : worldTime - LOG_KEEP_S).catch(() => null);
      if (saved === null) { this.#loaded.delete(b.bountyId); continue; } // tried again at the next refresh
      const mine = this.#tracks.get(b.bountyId) ?? [];
      const merged = [...saved.map(({ x, z, state, worldTime: t }) => ({ x, z, state, worldTime: t })), ...mine]
        .sort((p, q) => p.worldTime - q.worldTime).slice(-LOG_MAX);
      if (merged.length) this.#tracks.set(b.bountyId, merged);
    }
  }

  /**
   * Adds each active target's real position and state to its track log (a timer calls this every
   * few seconds). A still animal leaves no new track: a sample is kept when it moved a few metres
   * or its state changed.
   */
  sample(positionOf: (animalId: string) => { x: number; z: number; state: string } | null, worldTime: number): void {
    for (const b of this.#byTarget.values()) {
      const at = positionOf(b.targetAnimalId);
      if (!at) continue;
      const log = this.#tracks.get(b.bountyId) ?? [];
      const last = log.at(-1);
      if (last && Math.hypot(at.x - last.x, at.z - last.z) < 3 && last.state === at.state) continue;
      const kept = { x: at.x, z: at.z, state: at.state, worldTime };
      log.push(kept);
      if (this.store.saveTrack) {
        const bountyId = b.bountyId;
        this.#queue = this.#queue.then(() => this.store.saveTrack!({ bountyId, ...kept })).catch(() => undefined);
      }
      while (log.length && (worldTime - log[0]!.worldTime > LOG_KEEP_S || log.length > LOG_MAX)) log.shift();
      this.#tracks.set(b.bountyId, log);
    }
  }

  /** The clues to each active bounty this animal is not sensing now. */
  #clues(observer: { animalId: string; x: number; z: number }, sensedNow: Set<string>, worldTime: number,
    patchIdAt?: (x: number, z: number) => number | null | undefined): Clue[] {
    const clues: Clue[] = [];
    const here = patchIdAt?.(observer.x, observer.z);
    for (const b of this.#byTarget.values()) {
      if (sensedNow.has(b.bountyId) || b.targetAnimalId === observer.animalId) continue;
      const log = this.#tracks.get(b.bountyId) ?? [];
      const species = b.targetSpeciesId ?? b.speciesId;
      const about = { bountyId: b.bountyId, ...(species ? { speciesId: species } : {}) };
      const age = (s: TrackSample) => worldTime - s.worldTime;
      const away = (s: TrackSample) => Math.hypot(s.x - observer.x, s.z - observer.z);
      const freshest = (pick: (s: TrackSample) => boolean, before = log.length) => {
        for (let i = before - 1; i >= 0; i--) if (age(log[i]!) >= 0 && pick(log[i]!)) return i;
        return -1;
      };
      // The last sample is where the target is now: never a track or a disturbance.
      const behind = (s: TrackSample) => age(s) >= LEFT_BEHIND_S;
      const t = freshest((s) => behind(s) && age(s) <= TRACKS_FADE_S && away(s) <= TRACK_RADIUS_M, log.length - 1);
      if (t >= 0) {
        const s = log[t]!, next = log[t + 1], prev = log[t - 1];
        const [from, to] = next ? [s, next] : prev ? [prev, s] : [s, s];
        clues.push({ kind: 'tracks', ...about, x: Math.round(s.x), z: Math.round(s.z), ageWorldSeconds: Math.round(age(s)),
          ...(from !== to ? { headingDeg: degrees(to.x - from.x, to.z - from.z) } : {}) });
      }
      const c = freshest((s) => CALLING.has(s.state) && age(s) <= CALL_RECENT_S && away(s) <= EARSHOT_M);
      if (c >= 0) {
        const s = log[c]!;
        clues.push({ kind: 'call', ...about, ageWorldSeconds: Math.round(age(s)),
          bearingDeg: (Math.round(degrees(s.x - observer.x, s.z - observer.z) / 10) * 10) % 360, distance: away(s) <= CALL_NEAR_M ? 'near' : 'far' });
      }
      if (here !== undefined && here !== null) {
        const now = log.at(-1);
        // A patch the target is still in is not news of where it went.
        const d = now && patchIdAt!(now.x, now.z) === here ? -1
          : freshest((s) => behind(s) && age(s) <= DISTURBANCE_S && patchIdAt!(s.x, s.z) === here, log.length - 1);
        if (d >= 0) clues.push({ kind: 'disturbance', ...about, ageWorldSeconds: Math.round(age(log[d]!)) });
      }
    }
    return clues;
  }

  /** Resolves when every entrant write queued so far has run. */
  idle(): Promise<void> { return this.#queue.then(() => undefined); }

  #flag(b: ActiveBounty, worldTime: number): BountyFlag {
    return { bountyId: b.bountyId, amountAtomic: b.amountAtomic.toString(), decimals: b.decimals,
      timeLeftWorldSeconds: Math.max(0, (b.deadlineWorldTime ?? worldTime) - worldTime) };
  }

  view(agentId: string, observer: { animalId: string; speciesId: string; x: number; z: number }, nearby: readonly Sensed[],
    c: { canopyAt(x: number, z: number): number; worldTime: number; patchIdAt?(x: number, z: number): number | null | undefined }): {
      nearby: Array<Sensed & { sense: string; bounty?: BountyFlag }>; lastSeen: Array<{ bountyId: string; x: number; z: number; worldTime: number } & Omit<BountyFlag, 'bountyId'>>; clues: Clue[] } {
    const conditions = { daylight: daylightAt(c.worldTime), windHeading: windAt(this.worldId(), c.worldTime) };
    const seen = this.#lastSeen.get(agentId) ?? new Map<string, { x: number; z: number; worldTime: number }>();
    const listed: Array<Sensed & { sense: string; bounty?: BountyFlag }> = [];
    for (const a of nearby) {
      const sense = perceive(observer, a, { ...conditions, canopy: c.canopyAt(a.x, a.z) });
      if (!sense) continue;
      const b = this.#byTarget.get(a.id);
      if (b && a.id !== observer.animalId) {
        seen.set(b.bountyId, { x: a.x, z: a.z, worldTime: c.worldTime });
        const key = `${b.bountyId}:${agentId}`;
        if (!this.#entered.has(key)) {
          this.#entered.add(key);
          this.#queue = this.#queue.then(() => this.store.recordEntrant(b.bountyId, agentId, observer.animalId, c.worldTime))
            .catch(() => { this.#entered.delete(key); }); // tried again at the next sighting
        }
        listed.push({ ...a, sense, bounty: this.#flag(b, c.worldTime) });
      } else listed.push({ ...a, sense });
    }
    if (seen.size) this.#lastSeen.set(agentId, seen);
    // A sensed bounty target leads the list, so however crowded the forest it is never cut off.
    listed.sort((a, b) => Number(!!b.bounty) - Number(!!a.bounty));
    const sensedNow = new Set(listed.filter((a) => a.bounty).map((a) => a.bounty!.bountyId));
    const lastSeen = [...seen.entries()].filter(([id]) => !sensedNow.has(id)).flatMap(([id, at]) => {
      const b = [...this.#byTarget.values()].find((x) => x.bountyId === id);
      if (!b) return [];
      const { bountyId: _id, ...flag } = this.#flag(b, c.worldTime);
      return [{ bountyId: id, ...at, ...flag }];
    });
    return { nearby: listed, lastSeen, clues: this.#clues(observer, sensedNow, c.worldTime, c.patchIdAt) };
  }
}
