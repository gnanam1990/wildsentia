/**
 * The live layer: outside agents steering animals in real time
 * (docs/2026-09-26-live-agents-design.md).
 *
 * The hourly ecology still owns each animal's body. This layer owns where an agent's animal
 * goes and what it does, at 10 Hz, within the species' own speeds, and hands grazing, drinking
 * and resting back to the ecology's finite rules. It also runs place drops: spotting, the
 * timed open, and handing a finished open to the reward ledger.
 */

import { CHAT_GAP_MS, HEAR_RADIUS_M, HEARD_FOR_MS, SHOWN_FOR_MS, cleanChat } from './chat.js';

export type Gait = 'walk' | 'trot' | 'run';
export type LiveAction = 'idle' | 'graze' | 'drink' | 'rest' | 'open' | 'feed' | 'hunt';

export interface AnimalView {
  id: string; speciesId: string; alive: boolean; controller?: string | undefined;
  position: { x: number; z: number; heading: number }; patchId: number; state: string; lifeStage: string;
  drives: { hunger: number; thirst: number; fatigue: number; fear: number };
}
export interface SpeciesMotion {
  displayName: string; walkMs: number; trotMs: number; sprintMs: number; sprintStaminaS: number; predator: boolean;
  /** What it hunts, and how often a hunt that reaches its prey ends in a kill. */
  preferredPrey: string[]; baseSuccess: number; eatsMeat: boolean;
  /** Eats grass, browse or roots: may graze. */
  eatsPlants: boolean;
  /** How well it hides while stalking (0-1), and how close it creeps before it sprints. */
  stalkConcealment: number; commitDistanceM: number;
  /** Herd members warn each other; pack hunters do better together; some climb, some fly. */
  alarmSharing: boolean; packHunter: boolean; climbs: boolean; flies: boolean;
  sightRangeM: number; detectionM: number; flightInitiationM: number; evasiveness: number; shoulderHeightM: number;
}
export interface PatchView { id: number; habitat: string; grassKg: number; waterL: number; land: boolean }

/** Everything the live layer may ask of, or do to, the world. */
export interface WorldPort {
  worldId(): string | null;
  /** The tree this patch's climbers use, if it has one. */
  treeAt(x: number, z: number): { x: number; z: number } | null;
  now(): number;
  /** World seconds that pass in one real second (12 at 12 world hours per real hour); 1 if unset. */
  worldRate?(): number;
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
  /** Where a wild animal is being shown right now (its recorded route at the played moment). */
  playedPosition(id: string): { x: number; z: number; heading: number } | null;
  /** The world time being played on screen, which trails the newest saved hour. */
  playedTime(): number;
  /** Records a hunt that reached its prey; true if it killed (a carcass now lies there). */
  resolveHunt(predatorId: string, preyId: string, at: { x: number; z: number; heading: number }, time: number, killed: boolean): boolean;
  /** An agent's meat-eater feeds at a carcass beside it; false if none is within reach. */
  feed(id: string, seconds: number): boolean;
  carcassNear(x: number, z: number, radius: number): { id: string; x: number; z: number } | null;
  /** Moves a wild animal during a real-time chase; the next hourly step starts from there. */
  placeWild(id: string, position: { x: number; z: number; heading: number }): boolean;
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
  /** The animal this agent's predator is chasing. */
  hunt?: { targetId: string; warned?: boolean } | null;
  /** A failed catch costs a moment before the predator can move again. */
  stunnedUntil?: number;
  /** Up its patch's tree, out of every ground hunter's reach (langur, squirrel). */
  perched?: boolean;
  /** In the air (vulture): straight over anything, landing only on land. */
  flying?: boolean;
  /** When it last moved at sprint speed (a run, or a hunt's charge): challenge rules judge this. */
  sprintedAt?: number;
  alarmedAt?: number;
  /** Ran its breath out in a hunt: it trots until it has recovered enough to sprint again. */
  winded?: boolean;
}
export interface Notice { at: number; text: string }
/** A line an agent's animal said, heard by agents nearby. */
export interface Said { agentId: string; name: string; animalId: string; x: number; z: number; text: string; at: number }
/** How a possession ended, for the leaderboard: a death counts as an animal lost. */
export type LifeEnd = 'died' | 'caught' | 'birth' | 'idle' | 'released';
export interface EndedLife { agentId: string; animalId: string; speciesId: string; since: number; endedAt: number; how: LifeEnd }
/** A live hunt that reached its prey, and which agents (if any) steered either side. */
export interface HuntOutcome { predatorId: string; preyId: string; predatorAgentId: string | null; preyAgentId: string | null; killed: boolean; at: number }
/** An agent command the live layer accepted, for challenge attempt logs. */
export interface CommandRecord { agentId: string; command: string; args: Record<string, unknown>; at: number }

/**
 * A wild animal the live layer has taken off its recorded route for a real-time chase:
 * prey fleeing an agent's predator, or a wild predator hunting an agent's animal. It stays
 * live until the next hour's recording starts from where the chase left it.
 */
export interface WildRunner {
  animalId: string; speciesId: string; x: number; z: number; heading: number;
  mode: 'flee' | 'chase' | 'idle'; otherId: string | null; stamina: number; stunnedUntil: number;
  /** A hunting runner creeps up first and only sprints once it commits. */
  committed?: boolean;
  /** Ran its breath out: it trots until it has recovered enough to sprint again. */
  winded?: boolean;
}

/**
 * Avatars by agent id, with an index by animal id kept in step with every change (observe and
 * every hunt ask "who steers this animal?" for each animal nearby).
 */
export class AvatarMap extends Map<string, Avatar> {
  readonly #byAnimal = new Map<string, Avatar>();
  override set(agentId: string, avatar: Avatar): this {
    this.#forget(agentId);
    super.set(agentId, avatar);
    this.#byAnimal.set(avatar.animalId, avatar);
    return this;
  }
  override delete(agentId: string): boolean {
    this.#forget(agentId);
    return super.delete(agentId);
  }
  override clear(): void {
    this.#byAnimal.clear();
    super.clear();
  }
  /** The avatar steering this animal, if any. */
  byAnimal(animalId: string): Avatar | undefined { return this.#byAnimal.get(animalId); }
  #forget(agentId: string): void {
    const old = this.get(agentId);
    if (old && this.#byAnimal.get(old.animalId) === old) this.#byAnimal.delete(old.animalId);
  }
}

export const DEATH_COOLDOWN_MS = 2 * 60_000;
const SCAN_SECONDS = 1;
/** How long an agent with no animal keeps its notices, and how often old entries are swept. */
const NOTICE_KEEP_MS = 60 * 60_000;
const PRUNE_EVERY_MS = 60_000;
/** How much breath a winded animal needs back before it sprints again. */
const RECOVERED_STAMINA = 0.25;

/** Out of breath at zero; able to sprint again only once it has recovered some. */
const winded = (stamina: number, was: boolean | undefined) => stamina <= 0 || (!!was && stamina < RECOVERED_STAMINA);
/** Breath comes back fastest standing or walking, slowly at a trot, never at a sprint. */
const recover = (stamina: number, dt: number, sprintStaminaS: number, gait: Gait) =>
  gait === 'run' ? stamina : Math.min(1, stamina + dt / (3 * sprintStaminaS) * (gait === 'walk' ? 1 : 0.3));

export class LiveLayer {
  readonly avatars = new AvatarMap();
  /** Wild animals taken off their recordings for a chase, by animal id. */
  readonly wild = new Map<string, WildRunner>();
  readonly #notices = new Map<string, Notice[]>();
  readonly #cooldowns = new Map<string, number>();
  /** Agents waiting, first come first served, for an animal of a species with none free. */
  readonly #queues = new Map<string, Array<{ agentId: string; agentName: string; since: number }>>();
  #claiming = new Set<string>();
  #scanIn = 0;
  #hour = Number.NaN;
  #pruneAt = 0;
  readonly #said: Said[] = [];
  readonly #lastSaid = new Map<string, number>();
  /** Told whenever an agent's time with an animal ends (the runtime records it). */
  onEnded: ((life: EndedLife) => void) | null = null;
  /** Told after every live hunt that reached its prey (challenges count kills and escapes). */
  onHunt: ((hunt: HuntOutcome) => void) | null = null;
  /** Told after every accepted agent command (challenges log them). */
  onCommand: ((record: CommandRecord) => void) | null = null;
  /**
   * Asked when an animal comes free, with how long the species queue's next agent has waited
   * (since, ms): true leaves the animal for someone who waited longer elsewhere (a challenge's list).
   */
  holdFreed: ((speciesId: string, since: number) => boolean) | null = null;

  constructor(private readonly world: WorldPort, private readonly drops: DropLedger | null = null,
    private readonly clock: () => number = Date.now, private readonly random: () => number = Math.random) {}

  /** Where an animal is right now: an agent's, a live chase's, or its recorded route's. */
  positionOf(animalId: string): { x: number; z: number; heading: number } | null {
    const a = this.avatars.byAnimal(animalId);
    if (a) return { x: a.x, z: a.z, heading: a.heading };
    const runner = this.wild.get(animalId);
    if (runner) return { x: runner.x, z: runner.z, heading: runner.heading };
    return this.world.playedPosition(animalId);
  }

  #avatarOf(animalId: string): Avatar | undefined {
    return this.avatars.byAnimal(animalId);
  }

  notices(agentId: string): Notice[] { return this.#notices.get(agentId) ?? []; }
  notify(agentId: string, text: string): void {
    const list = this.#notices.get(agentId) ?? [];
    list.push({ at: this.clock(), text });
    if (list.length > 20) list.shift();
    this.#notices.set(agentId, list);
  }

  /** Takes over an animal: a named one, or any free one of a species. */
  possess(agentId: string, agentName: string, choice: { animalId?: string; speciesId?: string }, queueIfNone = true): { ok: true; avatar: Avatar } | { ok: false; reason: string } {
    if (this.avatars.has(agentId)) return { ok: false, reason: 'already_possessing' };
    // After an animal dies, a short wait before the next: death has to cost something.
    if ((this.#cooldowns.get(agentId) ?? 0) > this.clock()) return { ok: false, reason: 'cooldown' };
    const target = choice.animalId ?? this.world.candidates(choice.speciesId ?? null, 20).find((a) => !this.wild.has(a.id))?.id;
    if (!target) {
      // None free: wait in line for the next one of this species (tigers, above all).
      if (queueIfNone && choice.speciesId && this.world.species(choice.speciesId)) {
        const queue = this.#queues.get(choice.speciesId) ?? [];
        if (!queue.some((q) => q.agentId === agentId)) queue.push({ agentId, agentName, since: this.clock() });
        this.#queues.set(choice.speciesId, queue);
        return { ok: false, reason: `queued:${queue.findIndex((q) => q.agentId === agentId) + 1}` };
      }
      return { ok: false, reason: 'no_free_animal' };
    }
    if (this.wild.has(target)) return { ok: false, reason: 'in_a_chase' };
    const block = this.world.possess(target, agentId);
    if (block) return { ok: false, reason: block };
    const animal = this.world.animal(target)!;
    // Spectators see it where the hour's recording is being played, which trails the world's own
    // position: it is taken over there (when that ground can be stood on), so it does not jump.
    const shown = this.world.playedPosition(target);
    const start = shown && this.world.patchAt(shown.x, shown.z)?.land && this.world.place(target, shown) ? shown : animal.position;
    const now = this.clock();
    const avatar: Avatar = { agentId, agentName, animalId: animal.id, speciesId: animal.speciesId,
      x: start.x, z: start.z, heading: start.heading, gait: 'walk', path: [],
      moving: false, action: 'idle', pendingSeconds: 0, stamina: 1, since: now, lastCommand: now, opening: null };
    this.avatars.set(agentId, avatar);
    // Holding an animal ends any wait in line.
    for (const queue of this.#queues.values()) {
      const at = queue.findIndex((q) => q.agentId === agentId);
      if (at >= 0) queue.splice(at, 1);
    }
    this.notify(agentId, `You are now ${animal.id} (${this.world.species(animal.speciesId)?.displayName ?? animal.speciesId}).`);
    return { ok: true, avatar };
  }

  /** Restores an avatar saved before a restart, if the world still agrees it is this agent's. */
  restore(saved: { agentId: string; agentName: string; animalId: string; x: number; z: number; heading: number; since: number; lastCommand?: number }): boolean {
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
      // Keep the saved idle clock: a restart must not hand an abandoned animal another 15 minutes.
      stamina: 1, since: saved.since, lastCommand: Math.min(saved.lastCommand ?? now, now), opening: null });
    return true;
  }

  release(agentId: string, why = 'You let your animal go back to the wild.', how: LifeEnd = 'released'): boolean {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return false;
    if (how === 'released') this.#command(agentId, 'release', {});
    this.#flushAction(avatar);
    this.world.release(avatar.animalId);
    this.#end(avatar, why, how);
    return true;
  }

  /** An animal of this species just came free: the next agent in line gets it. */
  #offerNext(speciesId: string): void {
    const queue = this.#queues.get(speciesId);
    if (!queue) return;
    for (let i = 0; i < queue.length;) {
      const next = queue[i]!;
      if (this.clock() - next.since > 30 * 60_000 || this.avatars.has(next.agentId)) { queue.splice(i, 1); continue; }
      if (this.holdFreed?.(speciesId, next.since)) return;
      // Never queue from here: a failed offer re-joining the same line would loop forever.
      const result = this.possess(next.agentId, next.agentName, { speciesId }, false);
      if (result.ok) {
        this.notify(next.agentId, `Your turn: a ${this.world.species(speciesId)?.displayName.toLowerCase() ?? speciesId} came free.`);
        return;
      }
      // Nothing to take yet: everyone keeps their place for the next one.
      if (result.reason === 'no_free_animal') return;
      i++; // This agent cannot take one right now (a cooldown); the next in line may.
    }
  }

  /** Walk, trot or run through up to twenty points, in order. */
  moveTo(agentId: string, points: Array<{ x: number; z: number }>, gait: Gait): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    if (points.length === 0 || points.length > MAX_WAYPOINTS) return 'bad_path';
    const flies = gait !== 'walk' && !!this.world.species(avatar.speciesId)?.flies;
    // A flyer may cross water and sea on the way, but lands only on land.
    for (const [i, p] of points.entries()) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return 'not_on_land';
      const patch = this.world.patchAt(p.x, p.z);
      if (!patch || (!patch.land && (!flies || i === points.length - 1))) return 'not_on_land';
    }
    this.#flushAction(avatar);
    avatar.perched = false; avatar.flying = flies;
    avatar.path = points.map((p) => ({ x: p.x, z: p.z }));
    avatar.gait = gait; avatar.moving = true; avatar.action = 'idle'; avatar.opening = null; avatar.hunt = null;
    avatar.lastCommand = this.clock();
    this.#command(agentId, 'move', { points: avatar.path.map((p) => ({ x: p.x, z: p.z })), gait });
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

  /** A person's play page is open: that keeps the animal from going idle, without being a command. */
  presence(agentId: string): boolean {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return false;
    avatar.lastCommand = this.clock();
    return true;
  }

  /**
   * A flyer that stops comes down where it is: only onto land, so over water or sea it flies on.
   * Error, or null once it is on the ground (or never left it).
   */
  #land(avatar: Avatar): string | null {
    if (!avatar.flying) return null;
    if (!this.world.place(avatar.animalId, { x: avatar.x, z: avatar.z, heading: avatar.heading })) return 'not_on_land';
    avatar.flying = false;
    return null;
  }

  stop(agentId: string): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    const landing = this.#land(avatar);
    if (landing) return landing;
    avatar.path = []; avatar.moving = false; avatar.hunt = null; if (avatar.action === 'hunt') avatar.action = 'idle';
    avatar.lastCommand = this.clock();
    this.#command(agentId, 'stop', {});
    return null;
  }

  /** Graze, drink, rest, or (a meat-eater at a carcass) feed where the animal stands; moving again ends it. */
  act(agentId: string, action: 'graze' | 'drink' | 'rest' | 'feed'): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    if (action === 'drink' && !this.world.waterPoints(avatar.x, avatar.z, 3).length) return 'not_at_water';
    if (action === 'graze' && !this.world.species(avatar.speciesId)?.eatsPlants) return 'does_not_graze';
    if (action === 'feed') {
      if (!this.world.species(avatar.speciesId)?.eatsMeat) return 'does_not_eat_meat';
      if (!this.world.carcassNear(avatar.x, avatar.z, 3)) return 'no_carcass_here';
    }
    if (avatar.perched && action !== 'rest') return 'come_down_first';
    const landing = this.#land(avatar);
    if (landing) return landing;
    avatar.hunt = null;
    this.#flushAction(avatar);
    avatar.path = []; avatar.moving = false; avatar.opening = null;
    avatar.action = action; avatar.lastCommand = this.clock();
    this.#command(agentId, 'act', { action });
    return null;
  }

  /**
   * Hunts an animal in sight: the predator runs it down in real time. A wild animal bolts when
   * the hunter comes within its flight distance; an agent's animal is warned and can run. On
   * reaching it, the species' own hunt odds decide. Only a species' natural prey can be hunted.
   */
  hunt(agentId: string, targetId: string): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    const me = this.world.species(avatar.speciesId);
    if (!me?.preferredPrey.length) return 'not_a_hunter';
    const target = this.world.animal(targetId);
    if (!target?.alive || target.id === avatar.animalId) return 'no_such_animal';
    if (!me.preferredPrey.includes(target.speciesId)) return 'not_its_prey';
    const at = this.positionOf(targetId);
    if (!at || Math.hypot(at.x - avatar.x, at.z - avatar.z) > me.sightRangeM) return 'out_of_sight';
    this.#flushAction(avatar);
    // A hunt is on the ground: down from any tree first.
    avatar.path = []; avatar.moving = true; avatar.opening = null; avatar.perched = false;
    avatar.hunt = { targetId }; avatar.action = 'hunt'; avatar.lastCommand = this.clock();
    this.#command(agentId, 'hunt', { targetId });
    return null;
  }

  /** Starts the timed open of a drop within reach. Eligibility is checked by the caller first. */
  openDrop(agentId: string, dropId: string): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    const drop = this.drops?.active().find((d) => d.id === dropId);
    if (!drop) return 'no_such_drop';
    if (Math.hypot(drop.x - avatar.x, drop.z - avatar.z) > OPEN_RADIUS_M) return 'too_far';
    const landing = this.#land(avatar);
    if (landing) return landing;
    this.#flushAction(avatar);
    avatar.path = []; avatar.moving = false; avatar.hunt = null; avatar.perched = false;
    avatar.action = 'open'; avatar.opening = { dropId, seconds: 0 }; avatar.lastCommand = this.clock();
    return null;
  }

  tick(dt: number): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 1);
    const now = this.clock();
    // A new hour's recording starts from where each finished chase left its animal.
    const hour = this.world.now();
    if (hour !== this.#hour) {
      this.#hour = hour;
      for (const [id, r] of this.wild) if (r.mode === 'idle') this.wild.delete(id);
      // Animals come free between hours too (a chase over, young grown, a mother's care done):
      // whoever is waiting in line is offered one, and anyone waiting too long leaves the line.
      for (const [speciesId, queue] of this.#queues) {
        this.#offerNext(speciesId);
        if (queue.length === 0) this.#queues.delete(speciesId);
      }
    }
    for (const avatar of [...this.avatars.values()]) {
      const animal = this.world.animal(avatar.animalId);
      if (!animal?.alive) {
        this.#cooldowns.set(avatar.agentId, now + DEATH_COOLDOWN_MS);
        this.#end(avatar, `${avatar.animalId} died. You can take over another animal in two minutes.`, 'died'); continue;
      }
      if (animal.controller !== avatar.agentId) { this.#end(avatar, `${avatar.animalId} gave birth and went back to the wild to raise her young.`, 'birth'); continue; }
      if (now - avatar.lastCommand > IDLE_RELEASE_MS) { this.release(avatar.agentId, 'You were idle for 15 minutes, so your animal went back to the wild.', 'idle'); continue; }
      const motion = this.world.species(avatar.speciesId)!;
      if (avatar.hunt) this.#huntStep(avatar, motion, dt, now);
      else if (avatar.moving) this.#move(avatar, motion, dt);
      else avatar.stamina = Math.min(1, avatar.stamina + dt / (3 * motion.sprintStaminaS));
      if (avatar.action === 'graze' || avatar.action === 'drink' || avatar.action === 'rest' || avatar.action === 'feed') {
        avatar.pendingSeconds += dt;
        if (avatar.pendingSeconds >= ACTION_FLUSH_SECONDS) this.#flushAction(avatar);
      }
      if (avatar.opening) this.#advanceOpening(avatar, dt);
    }
    for (const runner of [...this.wild.values()]) this.#runnerStep(runner, dt, now);
    this.#scanIn -= dt;
    if (this.#scanIn <= 0) { this.#scanIn = SCAN_SECONDS; this.#scanForWildHunters(); this.#herdAlarm(now); }
    this.#spot();
    if (now >= this.#pruneAt) { this.#pruneAt = now + PRUNE_EVERY_MS; this.#prune(now); }
  }

  /** Forgets what no longer matters, so per-agent state does not grow with every agent ever seen. */
  #prune(now: number): void {
    for (const [agentId, until] of this.#cooldowns) if (until <= now) this.#cooldowns.delete(agentId);
    for (const [agentId, at] of this.#lastSaid) if (now - at >= CHAT_GAP_MS) this.#lastSaid.delete(agentId);
    for (const [agentId, list] of this.#notices) {
      if (!this.avatars.has(agentId) && now - (list.at(-1)?.at ?? 0) > NOTICE_KEEP_MS) this.#notices.delete(agentId);
    }
  }

  // ---- Hunting (Phase 2) -------------------------------------------------------------------

  #contact(a: SpeciesMotion, b: SpeciesMotion): number {
    return Math.max(1.2, (a.shoulderHeightM + b.shoulderHeightM) * 0.65);
  }

  /** One step towards, or away from, a point at a gait; false if the ground ahead is not land. */
  #stepToward(id: string, from: { x: number; z: number }, to: { x: number; z: number }, metres: number, away: boolean, wild: boolean):
    { x: number; z: number; heading: number } | null {
    let dx = to.x - from.x, dz = to.z - from.z;
    const gap = Math.hypot(dx, dz);
    if (gap < 1e-6) return { x: from.x, z: from.z, heading: 0 };
    if (away) { dx = -dx; dz = -dz; }
    // A fleeing animal that meets water or sea veers to either side before it gives up.
    for (const turn of away ? [0, 0.7, -0.7, 1.4, -1.4] : [0]) {
      const heading = Math.atan2(dx, dz) + turn, step = away ? metres : Math.min(metres, gap);
      const next = { x: from.x + Math.sin(heading) * step, z: from.z + Math.cos(heading) * step, heading };
      if (wild ? this.world.placeWild(id, next) : this.world.place(id, next)) return next;
    }
    return null;
  }

  #huntStep(avatar: Avatar, motion: SpeciesMotion, dt: number, now: number): void {
    if (now < (avatar.stunnedUntil ?? 0)) return;
    const targetId = avatar.hunt!.targetId;
    const target = this.world.animal(targetId);
    const at = target?.alive ? this.positionOf(targetId) : null;
    const stop = (text: string) => { avatar.hunt = null; avatar.action = 'idle'; avatar.moving = false; this.notify(avatar.agentId, text); };
    if (!at || !target) return stop('Your prey is gone.');
    if (this.#avatarOf(targetId)?.perched) return stop('It climbed out of reach.');
    if (this.#avatarOf(targetId)?.flying) return stop('It took to the air.');
    const gap = Math.hypot(at.x - avatar.x, at.z - avatar.z);
    if (gap > motion.sightRangeM * 1.5) return stop('You lost sight of it.');
    const prey = this.world.species(target.speciesId)!;
    // Stalk (walk, hidden) until close enough to commit, then sprint.
    const committed = gap <= motion.commitDistanceM;
    // Spent, it keeps after its prey at a trot until it has its breath back.
    avatar.winded = winded(avatar.stamina, avatar.winded);
    const gait: Gait = !committed ? 'walk' : avatar.winded ? 'trot' : 'run';
    avatar.stamina = recover(avatar.stamina, dt, motion.sprintStaminaS, gait);
    // Prey spots a sprinting hunter at its detection distance, a stalker only when it is close.
    const spotAt = committed ? prey.detectionM : prey.flightInitiationM * (1 - motion.stalkConcealment);
    if (gap <= spotAt) {
      if (!target.controller && !this.wild.has(targetId)) this.#startRunner(targetId, target.speciesId, at, 'flee', avatar.animalId);
      const quarry = this.#avatarOf(targetId);
      if (quarry && !avatar.hunt!.warned) {
        avatar.hunt!.warned = true;
        this.notify(quarry.agentId, `A ${motion.displayName.toLowerCase()} is charging at you. Run!`);
      }
    }
    const reach = this.#contact(motion, prey);
    if (gap <= reach) { this.#reach(avatar.animalId, targetId, at); return; }
    if (gait === 'run') { avatar.stamina = Math.max(0, avatar.stamina - dt / motion.sprintStaminaS); avatar.sprintedAt = this.clock(); }
    const speed = (gait === 'run' ? motion.sprintMs : gait === 'trot' ? motion.trotMs : motion.walkMs) * this.world.speedFactor(avatar.animalId, avatar.x, avatar.z);
    const next = this.#stepToward(avatar.animalId, avatar, at, Math.min(speed * dt, Math.max(0, gap - reach * 0.5)), false, false);
    if (!next) return stop('Blocked: the way to your prey is not walkable land.');
    avatar.x = next.x; avatar.z = next.z; avatar.heading = next.heading; avatar.gait = gait; avatar.moving = true;
    // Contact is judged after the step, or a fleeing animal that moves next would always be just out of reach.
    if (Math.hypot(at.x - avatar.x, at.z - avatar.z) <= reach) this.#reach(avatar.animalId, targetId, at);
  }

  #startRunner(animalId: string, speciesId: string, at: { x: number; z: number; heading: number }, mode: 'flee' | 'chase', otherId: string): void {
    const existing = this.wild.get(animalId);
    if (existing) { existing.mode = mode; existing.otherId = otherId; existing.committed = false; return; }
    this.wild.set(animalId, { animalId, speciesId, x: at.x, z: at.z, heading: at.heading, mode, otherId, stamina: 1, stunnedUntil: 0, committed: false });
  }

  #runnerStep(r: WildRunner, dt: number, now: number): void {
    const animal = this.world.animal(r.animalId);
    if (!animal?.alive || animal.controller) { this.wild.delete(r.animalId); return; }
    const motion = this.world.species(r.speciesId)!;
    if (r.mode === 'idle' || now < r.stunnedUntil) { r.stamina = Math.min(1, r.stamina + dt / (3 * motion.sprintStaminaS)); return; }
    const other = r.otherId ? this.positionOf(r.otherId) : null;
    const otherAlive = r.otherId ? this.world.animal(r.otherId)?.alive : false;
    if (!other || !otherAlive) { r.mode = 'idle'; return; }
    const quarryAvatar = r.otherId ? this.#avatarOf(r.otherId) : undefined;
    if (r.mode === 'chase' && (quarryAvatar?.perched || quarryAvatar?.flying)) { r.mode = 'idle'; return; }
    const gap = Math.hypot(other.x - r.x, other.z - r.z);
    // A wild hunter creeps up at a walk until it is close enough to commit, like any stalker.
    const stalking = r.mode === 'chase' && !r.committed && gap > motion.commitDistanceM;
    if (r.mode === 'chase' && !stalking && !r.committed) {
      r.committed = true;
      const quarry = this.#avatarOf(r.otherId!);
      if (quarry) this.notify(quarry.agentId, `A ${motion.displayName.toLowerCase()} is charging at you. Run!`);
    }
    r.winded = winded(r.stamina, r.winded);
    const running = !stalking && !r.winded;
    if (running) r.stamina = Math.max(0, r.stamina - dt / motion.sprintStaminaS);
    else r.stamina = recover(r.stamina, dt, motion.sprintStaminaS, stalking ? 'walk' : 'trot');
    const speed = (stalking ? motion.walkMs : running ? motion.sprintMs : motion.trotMs) * this.world.speedFactor(r.animalId, r.x, r.z);
    if (r.mode === 'flee') {
      if (gap > Math.max(3 * motion.flightInitiationM, 80)) { r.mode = 'idle'; return; }
      const next = this.#stepToward(r.animalId, r, other, speed * dt, true, true);
      if (!next) { r.mode = 'idle'; return; }
      Object.assign(r, next);
      return;
    }
    // A wild predator chasing an agent's animal: flat out until its breath gives out.
    const preyId = r.otherId!, prey = this.world.species(this.world.animal(preyId)!.speciesId)!;
    const reach = this.#contact(motion, prey);
    if (gap <= reach) { this.#reach(r.animalId, preyId, other); return; }
    if ((!running && !stalking) || gap > motion.sightRangeM * 1.5) {
      r.mode = 'idle';
      const quarry = this.#avatarOf(preyId);
      if (quarry) this.notify(quarry.agentId, `The ${motion.displayName.toLowerCase()} gave up the chase.`);
      return;
    }
    const next = this.#stepToward(r.animalId, r, other, Math.min(speed * dt, Math.max(0, gap - reach * 0.5)), false, true);
    if (!next) { r.mode = 'idle'; return; }
    Object.assign(r, next);
    if (Math.hypot(other.x - r.x, other.z - r.z) <= reach) this.#reach(r.animalId, preyId, other);
  }

  /** A hunter reached its prey: the species' odds decide, and the world records it. */
  #reach(predatorId: string, preyId: string, at: { x: number; z: number; heading: number }): void {
    const predatorAnimal = this.world.animal(predatorId), preyAnimal = this.world.animal(preyId);
    if (!predatorAnimal || !preyAnimal) return;
    const pm = this.world.species(predatorAnimal.speciesId)!, prm = this.world.species(preyAnimal.speciesId)!;
    const hunterAvatar = this.#avatarOf(predatorId), hunterRunner = this.wild.get(predatorId);
    const preyAvatar = this.#avatarOf(preyId), preyRunner = this.wild.get(preyId);
    const tired = (preyAvatar?.stamina ?? preyRunner?.stamina ?? 1) < 0.15;
    // Pack hunters do better together: every packmate closing on the same prey adds a third.
    let pack = 0;
    if (pm.packHunter) {
      for (const a of this.avatars.values()) if (a.animalId !== predatorId && a.speciesId === predatorAnimal.speciesId
        && Math.hypot(a.x - at.x, a.z - at.z) <= 30) pack++;
      for (const r of this.wild.values()) if (r.animalId !== predatorId && r.speciesId === predatorAnimal.speciesId
        && Math.hypot(r.x - at.x, r.z - at.z) <= 30) pack++;
    }
    const chance = Math.min(0.9, Math.max(0.1, pm.baseSuccess * (1.4 - prm.evasiveness * 0.8) * (tired ? 1.3 : 1) * (1 + Math.min(3, pack) / 3)));
    const killed = this.random() < chance;
    const recorded = this.world.resolveHunt(predatorId, preyId, at, this.world.playedTime(), killed);
    const now = this.clock();
    this.onHunt?.({ predatorId, preyId, predatorAgentId: hunterAvatar?.agentId ?? null, preyAgentId: preyAvatar?.agentId ?? null,
      killed: killed && recorded, at: now });
    if (killed && recorded) {
      if (hunterAvatar) {
        hunterAvatar.hunt = null; hunterAvatar.action = 'idle'; hunterAvatar.moving = false;
        this.notify(hunterAvatar.agentId, `You caught the ${prm.displayName.toLowerCase()}. Stay by it and feed (act feed).`);
      }
      if (hunterRunner) hunterRunner.mode = 'idle';
      this.wild.delete(preyId);
      if (preyAvatar) {
        this.#cooldowns.set(preyAvatar.agentId, now + DEATH_COOLDOWN_MS);
        this.#end(preyAvatar, `Your ${prm.displayName.toLowerCase()} was caught by a ${pm.displayName.toLowerCase()}. You can take over another animal in two minutes.`, 'caught');
      }
      return;
    }
    // It broke free: the hunter loses a moment, the prey a head start.
    if (hunterAvatar) { hunterAvatar.stunnedUntil = now + 2000; this.notify(hunterAvatar.agentId, 'It broke free. Keep after it, or stop.'); }
    if (hunterRunner) hunterRunner.stunnedUntil = now + 2000;
    if (preyAvatar) this.notify(preyAvatar.agentId, `You broke free of the ${pm.displayName.toLowerCase()}. Keep running!`);
    else if (!preyAnimal.controller) this.#startRunner(preyId, preyAnimal.speciesId, at, 'flee', predatorId);
  }

  /**
   * A herd runs together: when one of an agent's kind bolts from danger nearby (a wild one
   * fleeing, or an agent's being charged), the agents' animals of that species close by are
   * warned, at most every half minute.
   */
  #herdAlarm(now: number): void {
    const alarms: Array<{ speciesId: string; x: number; z: number; except: string }> = [];
    for (const r of this.wild.values()) if (r.mode === 'flee') alarms.push({ speciesId: r.speciesId, x: r.x, z: r.z, except: r.animalId });
    for (const r of this.wild.values()) if (r.mode === 'chase' && r.committed && r.otherId) {
      const quarry = this.#avatarOf(r.otherId);
      if (quarry) alarms.push({ speciesId: quarry.speciesId, x: quarry.x, z: quarry.z, except: quarry.animalId });
    }
    for (const a of this.avatars.values()) if (a.hunt) {
      const at = this.positionOf(a.hunt.targetId), prey = this.world.animal(a.hunt.targetId);
      if (at && prey && a.gait === 'run') alarms.push({ speciesId: prey.speciesId, x: at.x, z: at.z, except: prey.id });
    }
    for (const avatar of this.avatars.values()) {
      if (now - (avatar.alarmedAt ?? 0) < 30_000 || !this.world.species(avatar.speciesId)?.alarmSharing) continue;
      if (alarms.some((al) => al.speciesId === avatar.speciesId && al.except !== avatar.animalId && Math.hypot(al.x - avatar.x, al.z - avatar.z) <= 80)) {
        avatar.alarmedAt = now;
        this.notify(avatar.agentId, 'Alarm: your herd is running from danger nearby.');
      }
    }
  }

  /** Hungry wild predators that can see an agent's animal they hunt come after it. */
  #scanForWildHunters(): void {
    for (const avatar of this.avatars.values()) {
      if (avatar.perched || avatar.flying) continue;
      if ([...this.wild.values()].some((r) => r.mode === 'chase' && r.otherId === avatar.animalId)) continue;
      for (const candidate of this.world.nearby(avatar.x, avatar.z, 1200, 60)) {
        if (candidate.controller || this.wild.has(candidate.id) || candidate.drives.hunger < 0.3) continue;
        const motion = this.world.species(candidate.speciesId);
        if (!motion?.preferredPrey.includes(avatar.speciesId)) continue;
        const at = this.world.playedPosition(candidate.id);
        if (!at || Math.hypot(at.x - avatar.x, at.z - avatar.z) > Math.min(motion.sightRangeM, 160)) continue;
        // It begins to stalk; the agent's animal only notices once it charges (or sees it nearby).
        this.#startRunner(candidate.id, candidate.speciesId, at, 'chase', avatar.animalId);
        break;
      }
    }
  }

  #move(avatar: Avatar, motion: SpeciesMotion, dt: number): void {
    let gait = avatar.gait;
    if (gait === 'run' && !avatar.flying) {
      avatar.stamina = Math.max(0, avatar.stamina - dt / motion.sprintStaminaS);
      if (avatar.stamina <= 0) gait = 'trot'; // Out of breath: it keeps going, slower.
    } else avatar.stamina = Math.min(1, avatar.stamina + dt / (3 * motion.sprintStaminaS) * (gait === 'walk' ? 1 : 0.3));
    const base = avatar.flying ? (gait === 'run' ? motion.sprintMs : motion.sprintMs * 0.6)
      : gait === 'run' ? motion.sprintMs : gait === 'trot' ? motion.trotMs : motion.walkMs;
    // Rough ground slows walkers, not a bird overhead.
    let budget = base * (avatar.flying ? 1 : this.world.speedFactor(avatar.animalId, avatar.x, avatar.z)) * dt;
    if (gait === 'run' && avatar.path.length) avatar.sprintedAt = this.clock();
    while (budget > 1e-6 && avatar.path.length) {
      const next = avatar.path[0]!, dx = next.x - avatar.x, dz = next.z - avatar.z, gap = Math.hypot(dx, dz);
      const step = Math.min(gap, budget);
      const heading = gap > 1e-6 ? Math.atan2(dx, dz) : avatar.heading;
      const x = avatar.x + (gap > 1e-6 ? dx / gap * step : 0), z = avatar.z + (gap > 1e-6 ? dz / gap * step : 0);
      // In the air the world keeps the last land it flew over; the live layer keeps the rest.
      const placed = this.world.place(avatar.animalId, { x, z, heading });
      if (!placed && !(avatar.flying && this.world.patchAt(x, z))) {
        avatar.path = []; avatar.moving = false;
        this.notify(avatar.agentId, 'Blocked: the way ahead is not walkable land.');
        return;
      }
      avatar.x = x; avatar.z = z; avatar.heading = heading; budget -= step;
      if (step >= gap - 1e-6) avatar.path.shift();
    }
    if (!avatar.path.length) { avatar.moving = false; avatar.flying = false; }
  }

  /**
   * Hands the time spent grazing, drinking, resting or feeding to the ecology. The body hungers
   * and tires at the world's pace, so real seconds count as world seconds at the world's speed,
   * an hour at most per call.
   */
  #flushAction(avatar: Avatar): void {
    const action = avatar.action;
    const rate = this.world.worldRate?.() ?? 1;
    let seconds = avatar.pendingSeconds * (Number.isFinite(rate) && rate > 0 ? rate : 1);
    avatar.pendingSeconds = 0;
    if (action !== 'graze' && action !== 'drink' && action !== 'rest' && action !== 'feed') return;
    while (seconds > 1e-9) {
      const part = Math.min(3600, seconds);
      seconds -= part;
      const done = action === 'feed' ? this.world.feed(avatar.animalId, part) : this.world.act(avatar.animalId, action, part);
      if (!done) return;
    }
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

  #command(agentId: string, command: string, args: Record<string, unknown>): void {
    this.onCommand?.({ agentId, command, args, at: this.clock() });
  }

  #end(avatar: Avatar, why: string, how: LifeEnd): void {
    this.avatars.delete(avatar.agentId);
    this.notify(avatar.agentId, why);
    this.onEnded?.({ agentId: avatar.agentId, animalId: avatar.animalId, speciesId: avatar.speciesId, since: avatar.since, endedAt: this.clock(), how });
    this.#offerNext(avatar.speciesId);
  }

  /**
   * A short line from an agent's animal, heard by other agents within HEAR_RADIUS_M. The text is
   * cleaned and checked (chat.ts); a muted agent, or one speaking again too soon, is refused.
   */
  say(agentId: string, raw: unknown, muted = false): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    if (muted) return 'muted';
    const clean = cleanChat(raw);
    if (!clean.ok) return clean.error;
    const now = this.clock();
    if (now - (this.#lastSaid.get(agentId) ?? -Infinity) < CHAT_GAP_MS) return 'too_soon';
    this.#lastSaid.set(agentId, now);
    this.#said.push({ agentId, name: avatar.agentName, animalId: avatar.animalId, x: avatar.x, z: avatar.z, text: clean.text, at: now });
    while (this.#said.length > 500 || (this.#said[0] && now - this.#said[0].at > HEARD_FOR_MS)) this.#said.shift();
    avatar.lastCommand = now;
    this.#command(agentId, 'say', { text: clean.text });
    return null;
  }

  /** What an agent's animal heard in the last two minutes: others' lines said within earshot of where it is now. */
  heard(agentId: string): Array<{ from: string; agentId: string; animalId: string; text: string; secondsAgo: number; distance: number }> {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return [];
    const now = this.clock();
    return this.#said.filter((s) => s.agentId !== agentId && now - s.at <= HEARD_FOR_MS)
      .map((s) => ({ s, d: Math.hypot(s.x - avatar.x, s.z - avatar.z) })).filter(({ d }) => d <= HEAR_RADIUS_M)
      .slice(-10).map(({ s, d }) => ({ from: s.name, agentId: s.agentId, animalId: s.animalId, text: s.text,
        secondsAgo: Math.round((now - s.at) / 1000), distance: Math.round(d) }));
  }

  /** Takes back everything an agent said (when the operator mutes it). */
  forgetSaid(agentId: string): void {
    for (let i = this.#said.length - 1; i >= 0; i--) if (this.#said[i]!.agentId === agentId) this.#said.splice(i, 1);
  }

  /** Up the tree beside it (langur, squirrel, leopard): no ground hunter can reach it there. */
  climb(agentId: string): string | null {
    const avatar = this.avatars.get(agentId);
    if (!avatar) return 'not_possessing';
    if (!this.world.species(avatar.speciesId)?.climbs) return 'cannot_climb';
    const tree = this.world.treeAt(avatar.x, avatar.z);
    if (!tree || Math.hypot(tree.x - avatar.x, tree.z - avatar.z) > 4) return 'no_tree_here';
    this.#flushAction(avatar);
    avatar.path = []; avatar.moving = false; avatar.hunt = null; avatar.opening = null; avatar.action = 'rest'; avatar.perched = true;
    avatar.lastCommand = this.clock();
    this.#command(agentId, 'climb', {});
    for (const r of this.wild.values()) if (r.mode === 'chase' && r.otherId === avatar.animalId) {
      r.mode = 'idle';
      this.notify(agentId, `The ${this.world.species(r.speciesId)?.displayName.toLowerCase()} cannot follow you up the tree.`);
    }
    return null;
  }

  /** @internal How many entries the per-agent maps hold (tests check they stay bounded). */
  __sizesForTest(): { notices: number; cooldowns: number; lastSaid: number; queues: number } {
    return { notices: this.#notices.size, cooldowns: this.#cooldowns.size, lastSaid: this.#lastSaid.size, queues: this.#queues.size };
  }

  /** What spectators see: every avatar and every live drop, positions only where public. */
  /** The line an agent's animal said in the last few seconds, for spectators. */
  #showing(agentId: string): { said?: string } {
    const now = this.clock();
    for (let i = this.#said.length - 1; i >= 0 && now - this.#said[i]!.at <= SHOWN_FOR_MS; i--) {
      if (this.#said[i]!.agentId === agentId) return { said: this.#said[i]!.text };
    }
    return {};
  }

  publicState(): { avatars: object[]; drops: object[]; wild: object[] } {
    return {
      avatars: [...this.avatars.values()].map((a) => ({ agentId: a.agentId, name: a.agentName, animalId: a.animalId,
        speciesId: a.speciesId, x: round(a.x), z: round(a.z), heading: round(a.heading, 3), gait: a.gait, moving: a.moving,
        action: a.action, opening: a.opening ? { dropId: a.opening.dropId, progress: round(a.opening.seconds / OPEN_SECONDS, 2) } : null,
        ...(a.perched ? { altitude: 6 } : a.flying ? { altitude: 30 } : {}),
        ...this.#showing(a.agentId) })),
      drops: (this.drops?.active() ?? []).map((d) => ({ id: d.id, amountMicro: d.amountMicro,
        hint: { x: round(d.hintX), z: round(d.hintZ), radius: d.hintRadius }, expiresAt: d.expiresAt,
        ...(d.spottedBy ? { spotted: { x: round(d.x), z: round(d.z), by: d.spottedBy } } : {}) })),
      wild: [...this.wild.values()].map((r) => ({ animalId: r.animalId, speciesId: r.speciesId, x: round(r.x), z: round(r.z),
        heading: round(r.heading, 3), mode: r.mode === 'chase' && !r.committed ? 'stalk' : r.mode })),
    };
  }
}

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
