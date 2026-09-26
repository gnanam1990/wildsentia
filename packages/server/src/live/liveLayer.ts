/**
 * The live layer: outside agents steering animals in real time
 * (docs/2026-09-26-live-agents-design.md).
 *
 * The hourly ecology still owns each animal's body. This layer owns where an agent's animal
 * goes and what it does, at 10 Hz, within the species' own speeds, and hands grazing, drinking
 * and resting back to the ecology's finite rules. It also runs place drops: spotting, the
 * timed open, and handing a finished open to the reward ledger.
 */

export type Gait = 'walk' | 'trot' | 'run';
export type LiveAction = 'idle' | 'graze' | 'drink' | 'rest' | 'open';

export interface AnimalView {
  id: string; speciesId: string; alive: boolean; controller?: string | undefined;
  position: { x: number; z: number; heading: number }; patchId: number; state: string; lifeStage: string;
  drives: { hunger: number; thirst: number; fatigue: number; fear: number };
}
export interface SpeciesMotion { displayName: string; walkMs: number; trotMs: number; sprintMs: number; sprintStaminaS: number; predator: boolean }
export interface PatchView { id: number; habitat: string; grassKg: number; waterL: number; land: boolean }

/** Everything the live layer may ask of, or do to, the world. */
export interface WorldPort {
  worldId(): string | null;
  now(): number;
  animal(id: string): AnimalView | null;
  species(id: string): SpeciesMotion | null;
  possessionBlock(id: string): string | null;
  possess(id: string, controller: string): string | null;
  release(id: string): void;
  place(id: string, position: { x: number; z: number; heading: number }): boolean;
  act(id: string, action: 'graze' | 'drink' | 'rest', seconds: number): boolean;
  /** Speed multiplier for the ground here (1 = open grass) and the animal's condition. */
  speedFactor(id: string, x: number, z: number): number;
  patchAt(x: number, z: number): PatchView | null;
  nearby(x: number, z: number, radius: number, limit: number): AnimalView[];
  waterPoints(x: number, z: number, radius: number): Array<{ patchId: number; x: number; z: number; litres: number }>;
  /** The cheapest land route for this species from one point to another, or null if none. */
  route(speciesId: string, from: { x: number; z: number }, to: { x: number; z: number }): { points: Array<{ x: number; z: number }>; metres: number } | null;
  /** Animals an agent could take now, for the possess menu. */
  candidates(speciesId: string | null, limit: number): AnimalView[];
}

export interface PlaceDrop {
  id: string; amountMicro: string; x: number; z: number; hintX: number; hintZ: number; hintRadius: number;
  expiresAt: number; spottedBy: string | null;
}
/** The reward ledger side of place drops. */
export interface DropLedger {
  active(): PlaceDrop[];
  spot(dropId: string, agentId: string): void;
  claim(dropId: string, agentId: string): Promise<{ ok: true; claimId: string } | { ok: false; reason: string }>;
}

export const TICK_HZ = 10;
export const SPOT_RADIUS_M = 10;
export const OPEN_RADIUS_M = 2;
export const OPEN_SECONDS = 5;
export const IDLE_RELEASE_MS = 15 * 60_000;
export const ACTION_FLUSH_SECONDS = 30;
const MAX_WAYPOINTS = 64;

export interface Avatar {
  agentId: string; agentName: string; animalId: string; speciesId: string;
  x: number; z: number; heading: number;
  gait: Gait; path: Array<{ x: number; z: number }>; moving: boolean;
  action: LiveAction; pendingSeconds: number;
  stamina: number; since: number; lastCommand: number;
  opening: { dropId: string; seconds: number } | null;
}
export interface Notice { at: number; text: string }

export class LiveLayer {
  readonly avatars = new Map<string, Avatar>();
  readonly #notices = new Map<string, Notice[]>();
  #claiming = new Set<string>();

  constructor(private readonly world: WorldPort, private readonly drops: DropLedger | null = null,
    private readonly clock: () => number = Date.now) {}

  notices(agentId: string): Notice[] { return this.#notices.get(agentId) ?? []; }
  notify(agentId: string, text: string): void {
    const list = this.#notices.get(agentId) ?? [];
    list.push({ at: this.clock(), text });
    if (list.length > 20) list.shift();
    this.#notices.set(agentId, list);
  }

  /** Takes over an animal: a named one, or any free one of a species. */
  possess(agentId: string, agentName: string, choice: { animalId?: string; speciesId?: string }): { ok: true; avatar: Avatar } | { ok: false; reason: string } {
    if (this.avatars.has(agentId)) return { ok: false, reason: 'already_possessing' };
    const target = choice.animalId ?? this.world.candidates(choice.speciesId ?? null, 1)[0]?.id;
    if (!target) return { ok: false, reason: 'no_free_animal' };
    const block = this.world.possess(target, agentId);
    if (block) return { ok: false, reason: block };
    const animal = this.world.animal(target)!;
    const now = this.clock();
    const avatar: Avatar = { agentId, agentName, animalId: animal.id, speciesId: animal.speciesId,
      x: animal.position.x, z: animal.position.z, heading: animal.position.heading, gait: 'walk', path: [],
      moving: false, action: 'idle', pendingSeconds: 0, stamina: 1, since: now, lastCommand: now, opening: null };
    this.avatars.set(agentId, avatar);
    this.notify(agentId, `You are now ${animal.id} (${this.world.species(animal.speciesId)?.displayName ?? animal.speciesId}).`);
    return { ok: true, avatar };
  }

  /** Restores an avatar saved before a restart, if the world still agrees it is this agent's. */
  restore(saved: { agentId: string; agentName: string; animalId: string; x: number; z: number; heading: number; since: number }): boolean {
    let animal = this.world.animal(saved.animalId);
    if (!animal?.alive) return false;
    if (animal.controller !== saved.agentId) {
      // The world's last checkpoint may predate the possession; take it again if still allowed.
      if (animal.controller || this.world.possess(saved.animalId, saved.agentId)) return false;
      animal = this.world.animal(saved.animalId)!;
    }
    const at = this.world.place(saved.animalId, { x: saved.x, z: saved.z, heading: saved.heading })
      ? { x: saved.x, z: saved.z, heading: saved.heading } : animal.position;
    const now = this.clock();
    this.avatars.set(saved.agentId, { agentId: saved.agentId, agentName: saved.agentName, animalId: saved.animalId,
      speciesId: animal.speciesId, ...at, gait: 'walk', path: [], moving: false, action: 'idle', pendingSeconds: 0,
      stamina: 1, since: saved.since, lastCommand: now, opening: null });
    return true;
  }

  release(agentId: string, why = 'You let your animal go back to the wild.'): boolean {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return false;
    this.#flushAction(avatar);
    this.world.release(avatar.animalId);
    this.avatars.delete(agentId);
    this.notify(agentId, why);
    return true;
  }

  /** Walk, trot or run through up to twenty points, in order. */
  moveTo(agentId: string, points: Array<{ x: number; z: number }>, gait: Gait): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    if (points.length === 0 || points.length > MAX_WAYPOINTS) return 'bad_path';
    for (const p of points) if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !this.world.patchAt(p.x, p.z)?.land) return 'not_on_land';
    this.#flushAction(avatar);
    avatar.path = points.map((p) => ({ x: p.x, z: p.z }));
    avatar.gait = gait; avatar.moving = true; avatar.action = 'idle'; avatar.opening = null;
    avatar.lastCommand = this.clock();
    return null;
  }

  /** Goes to a point by the cheapest land route, round water and sea. */
  goTo(agentId: string, to: { x: number; z: number }, gait: Gait): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    if (!Number.isFinite(to.x) || !Number.isFinite(to.z)) return 'not_on_land';
    const route = this.world.route(avatar.speciesId, avatar, to);
    if (!route) return 'no_land_route';
    return this.moveTo(agentId, route.points, gait);
  }

  stop(agentId: string): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    avatar.path = []; avatar.moving = false; avatar.lastCommand = this.clock();
    return null;
  }

  /** Graze, drink or rest where the animal stands; moving again ends it. */
  act(agentId: string, action: 'graze' | 'drink' | 'rest'): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    if (action === 'drink' && !this.world.waterPoints(avatar.x, avatar.z, 3).length) return 'not_at_water';
    this.#flushAction(avatar);
    avatar.path = []; avatar.moving = false; avatar.opening = null;
    avatar.action = action; avatar.lastCommand = this.clock();
    return null;
  }

  /** Starts the timed open of a drop within reach. Eligibility is checked by the caller first. */
  openDrop(agentId: string, dropId: string): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    const drop = this.drops?.active().find((d) => d.id === dropId);
    if (!drop) return 'no_such_drop';
    if (Math.hypot(drop.x - avatar.x, drop.z - avatar.z) > OPEN_RADIUS_M) return 'too_far';
    this.#flushAction(avatar);
    avatar.path = []; avatar.moving = false;
    avatar.action = 'open'; avatar.opening = { dropId, seconds: 0 }; avatar.lastCommand = this.clock();
    return null;
  }

  tick(dt: number): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 1);
    const now = this.clock();
    for (const avatar of [...this.avatars.values()]) {
      const animal = this.world.animal(avatar.animalId);
      if (!animal?.alive) { this.#end(avatar, `${avatar.animalId} died. You can take over another animal.`); continue; }
      if (animal.controller !== avatar.agentId) { this.#end(avatar, `${avatar.animalId} gave birth and went back to the wild to raise her young.`); continue; }
      if (now - avatar.lastCommand > IDLE_RELEASE_MS) { this.release(avatar.agentId, 'You were idle for 15 minutes, so your animal went back to the wild.'); continue; }
      const motion = this.world.species(avatar.speciesId)!;
      if (avatar.moving) this.#move(avatar, motion, dt);
      else avatar.stamina = Math.min(1, avatar.stamina + dt / (3 * motion.sprintStaminaS));
      if (avatar.action === 'graze' || avatar.action === 'drink' || avatar.action === 'rest') {
        avatar.pendingSeconds += dt;
        if (avatar.pendingSeconds >= ACTION_FLUSH_SECONDS) this.#flushAction(avatar);
      }
      if (avatar.opening) this.#advanceOpening(avatar, dt);
    }
    this.#spot();
  }

  #move(avatar: Avatar, motion: SpeciesMotion, dt: number): void {
    let gait = avatar.gait;
    if (gait === 'run') {
      avatar.stamina = Math.max(0, avatar.stamina - dt / motion.sprintStaminaS);
      if (avatar.stamina <= 0) gait = 'trot'; // Out of breath: it keeps going, slower.
    } else avatar.stamina = Math.min(1, avatar.stamina + dt / (3 * motion.sprintStaminaS) * (gait === 'walk' ? 1 : 0.3));
    const base = gait === 'run' ? motion.sprintMs : gait === 'trot' ? motion.trotMs : motion.walkMs;
    let budget = base * this.world.speedFactor(avatar.animalId, avatar.x, avatar.z) * dt;
    while (budget > 1e-6 && avatar.path.length) {
      const next = avatar.path[0]!, dx = next.x - avatar.x, dz = next.z - avatar.z, gap = Math.hypot(dx, dz);
      const step = Math.min(gap, budget);
      const heading = gap > 1e-6 ? Math.atan2(dx, dz) : avatar.heading;
      const x = avatar.x + (gap > 1e-6 ? dx / gap * step : 0), z = avatar.z + (gap > 1e-6 ? dz / gap * step : 0);
      if (!this.world.place(avatar.animalId, { x, z, heading })) {
        avatar.path = []; avatar.moving = false;
        this.notify(avatar.agentId, 'Blocked: the way ahead is not walkable land.');
        return;
      }
      avatar.x = x; avatar.z = z; avatar.heading = heading; budget -= step;
      if (step >= gap - 1e-6) avatar.path.shift();
    }
    if (!avatar.path.length) avatar.moving = false;
  }

  #flushAction(avatar: Avatar): void {
    const action = avatar.action;
    if ((action === 'graze' || action === 'drink' || action === 'rest') && avatar.pendingSeconds > 0) {
      this.world.act(avatar.animalId, action, Math.min(3600, avatar.pendingSeconds));
    }
    avatar.pendingSeconds = 0;
  }

  #advanceOpening(avatar: Avatar, dt: number): void {
    const opening = avatar.opening!;
    const drop = this.drops?.active().find((d) => d.id === opening.dropId);
    if (!drop || Math.hypot(drop.x - avatar.x, drop.z - avatar.z) > OPEN_RADIUS_M) {
      avatar.opening = null; avatar.action = 'idle';
      this.notify(avatar.agentId, 'The drop is gone or out of reach.');
      return;
    }
    opening.seconds += dt;
    if (opening.seconds < OPEN_SECONDS || this.#claiming.has(drop.id)) return;
    this.#claiming.add(drop.id);
    avatar.opening = null; avatar.action = 'idle';
    void this.drops!.claim(drop.id, avatar.agentId).then((result) => {
      this.notify(avatar.agentId, result.ok ? `You opened the drop and won ${Number(drop.amountMicro) / 1e6} USDC. Claim ${result.claimId}.`
        : `Someone else got there first (${result.reason}).`);
    }, () => this.notify(avatar.agentId, 'The drop could not be recorded; try opening it again.'))
      .finally(() => this.#claiming.delete(drop.id));
  }

  #spot(): void {
    if (!this.drops) return;
    for (const drop of this.drops.active()) {
      if (drop.spottedBy) continue;
      for (const avatar of this.avatars.values()) {
        if (Math.hypot(drop.x - avatar.x, drop.z - avatar.z) > SPOT_RADIUS_M) continue;
        this.drops.spot(drop.id, avatar.agentId);
        this.notify(avatar.agentId, `You spotted a drop at (${drop.x.toFixed(1)}, ${drop.z.toFixed(1)}).`);
        break;
      }
    }
  }

  #end(avatar: Avatar, why: string): void {
    this.avatars.delete(avatar.agentId);
    this.notify(avatar.agentId, why);
  }

  /** What spectators see: every avatar and every live drop, positions only where public. */
  publicState(): { avatars: object[]; drops: object[] } {
    return {
      avatars: [...this.avatars.values()].map((a) => ({ agentId: a.agentId, name: a.agentName, animalId: a.animalId,
        speciesId: a.speciesId, x: round(a.x), z: round(a.z), heading: round(a.heading, 3), gait: a.gait, moving: a.moving,
        action: a.action, opening: a.opening ? { dropId: a.opening.dropId, progress: round(a.opening.seconds / OPEN_SECONDS, 2) } : null })),
      drops: (this.drops?.active() ?? []).map((d) => ({ id: d.id, amountMicro: d.amountMicro,
        hint: { x: round(d.hintX), z: round(d.hintZ), radius: d.hintRadius }, expiresAt: d.expiresAt,
        ...(d.spottedBy ? { spotted: { x: round(d.x), z: round(d.z), by: d.spottedBy } } : {}) })),
    };
  }
}

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
