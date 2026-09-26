import * as THREE from 'three';
import type { AnimalState } from './protocol.js';
import type { LivePose } from './liveEncounters.js';

/**
 * Animals steered by outside AI agents, and the USDC place drops they race to open
 * (docs/2026-09-26-live-agents-design.md). The server streams both four times a second;
 * avatars are drawn a quarter of a second behind, between the last two updates, so they
 * move smoothly. Drops are a hint circle, then a light beam once an animal has spotted one.
 */

export interface LiveAvatar {
  agentId: string; name: string; animalId: string; speciesId: string;
  x: number; z: number; heading: number; gait: 'walk' | 'trot' | 'run'; moving: boolean;
  action: 'idle' | 'graze' | 'drink' | 'rest' | 'open' | 'feed' | 'hunt';
  opening: { dropId: string; progress: number } | null;
  /** Metres above ground: up a tree, or in the air. */
  altitude?: number;
}
export interface LiveDrop {
  id: string; amountMicro: string; hint: { x: number; z: number; radius: number }; expiresAt: number;
  spotted?: { x: number; z: number; by: string };
}
/** A wild animal in a live chase, off its recording: fleeing an agent's hunter, or stalking/chasing an agent's animal. */
export interface LiveWild { animalId: string; speciesId: string; x: number; z: number; heading: number; mode: 'flee' | 'stalk' | 'chase' | 'idle' }
export interface LiveMessage { type: 'live'; at: number; avatars: LiveAvatar[]; drops: LiveDrop[]; wild?: LiveWild[] }
/** Everyone playing, in brief, every couple of seconds; `live` carries only those near the camera. */
export interface RosterEntry { agentId: string; name: string; animalId: string; speciesId: string; x: number; z: number; activity: string }
export interface RosterMessage { type: 'live-roster'; agents: RosterEntry[] }

export function isRosterMessage(value: unknown): value is RosterMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.type === 'live-roster' && Array.isArray(m.agents) && m.agents.length <= 5000 && m.agents.every((a) => {
    const v = a as Record<string, unknown>;
    return text(v.agentId) && text(v.name, 40) && text(v.animalId) && text(v.speciesId) && finite(v.x) && finite(v.z) && text(v.activity, 16);
  });
}

const ROSTER_ACTIVITY: Record<string, string> = { walk: 'walking', trot: 'trotting', run: 'running', idle: 'standing',
  graze: 'grazing', drink: 'drinking', rest: 'resting', open: 'opening a drop', hunt: 'hunting', feed: 'feeding', fly: 'flying' };
export const rosterActivity = (a: RosterEntry) => ROSTER_ACTIVITY[a.activity] ?? a.activity;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function isLiveMessage(value: unknown): value is LiveMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.type !== 'live' || !finite(m.at) || !Array.isArray(m.avatars) || !Array.isArray(m.drops) || m.avatars.length > 2000 || m.drops.length > 200) return false;
  return m.avatars.every((a) => {
    const v = a as Record<string, unknown>;
    return text(v.agentId) && text(v.name, 40) && text(v.animalId) && text(v.speciesId) && finite(v.x) && finite(v.z) && finite(v.heading)
      && ['walk', 'trot', 'run'].includes(v.gait as string) && typeof v.moving === 'boolean'
      && ['idle', 'graze', 'drink', 'rest', 'open', 'feed', 'hunt'].includes(v.action as string)
      && (v.altitude === undefined || (finite(v.altitude) && v.altitude >= 0 && v.altitude <= 200));
  }) && (m.wild === undefined || (Array.isArray(m.wild) && m.wild.length <= 2000 && m.wild.every((w) => {
    const v = w as Record<string, unknown>;
    return text(v.animalId) && text(v.speciesId) && finite(v.x) && finite(v.z) && finite(v.heading)
      && ['flee', 'stalk', 'chase', 'idle'].includes(v.mode as string);
  }))) && m.drops.every((d) => {
    const v = d as Record<string, unknown>, hint = v.hint as Record<string, unknown> | undefined;
    return text(v.id) && typeof v.amountMicro === 'string' && /^[0-9]{1,15}$/.test(v.amountMicro) && !!hint
      && finite(hint.x) && finite(hint.z) && finite(hint.radius);
  });
}

const ACTION_STATE: Record<LiveAvatar['action'], string> = { idle: 'resting', graze: 'grazing', drink: 'drinking', rest: 'resting', open: 'resting',
  feed: 'feeding', hunt: 'stalking' };
const ACTION_LABEL: Record<LiveAvatar['action'], string> = { idle: 'standing', graze: 'grazing', drink: 'drinking', rest: 'resting', open: 'opening a drop',
  feed: 'feeding on a carcass', hunt: 'hunting' };
const WILD_STATE: Record<LiveWild['mode'], string> = { flee: 'fleeing', stalk: 'stalking', chase: 'chasing', idle: 'resting' };

export function activityOf(a: LiveAvatar): string {
  if (a.action === 'hunt') return a.gait === 'run' ? 'charging' : 'stalking prey';
  if ((a.altitude ?? 0) >= 20) return 'flying';
  if ((a.altitude ?? 0) > 0) return 'up a tree';
  if (a.moving) return a.gait === 'run' ? 'running' : a.gait === 'trot' ? 'trotting' : 'walking';
  return ACTION_LABEL[a.action];
}

const lerpAngle = (a: number, b: number, t: number) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * t;
export const usdc = (micro: string) => (Number(micro) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 });

export class LiveAgents {
  readonly root = new THREE.Group();
  #previous: LiveMessage | null = null;
  #latest: LiveMessage | null = null;
  #receivedAt = 0;
  #roster: RosterEntry[] = [];
  readonly #drops = new Map<string, { group: THREE.Group; ring: THREE.Mesh; beam: THREE.Mesh; crate: THREE.Mesh; progress: THREE.Mesh }>();
  readonly #ringGeometry = new THREE.RingGeometry(0.97, 1, 96).rotateX(-Math.PI / 2);
  readonly #ringMaterial = new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  readonly #beamGeometry = new THREE.CylinderGeometry(0.6, 0.6, 60, 16, 1, true).translate(0, 30, 0);
  readonly #beamMaterial = new THREE.MeshBasicMaterial({ color: 0xffd766, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  readonly #crateGeometry = new THREE.BoxGeometry(0.8, 0.6, 0.8).translate(0, 0.3, 0);
  readonly #crateMaterial = new THREE.MeshStandardMaterial({ color: 0xe0ad63, emissive: 0x6b4a10, roughness: 0.6 });
  readonly #progressMaterial = new THREE.MeshBasicMaterial({ color: 0x7fc98a, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    this.root.name = 'live-agents';
  }

  apply(message: LiveMessage, nowMs: number): void {
    this.#previous = this.#latest; this.#latest = message; this.#receivedAt = nowMs;
    this.#syncDrops(message.drops);
  }

  applyRoster(message: RosterMessage): void { this.#roster = message.agents; }
  /** Everyone playing, near the camera or not. */
  get roster(): RosterEntry[] { return this.#roster; }

  clear(): void { this.#previous = this.#latest = null; this.#roster = []; this.#syncDrops([]); }

  get avatars(): LiveAvatar[] { return this.#latest?.avatars ?? []; }
  get drops(): LiveDrop[] { return this.#latest?.drops ?? []; }
  avatarForAnimal(animalId: string): LiveAvatar | undefined { return this.avatars.find((a) => a.animalId === animalId); }

  /** Where each avatar is drawn now: a quarter second behind, between the last two updates. */
  positions(nowMs: number): Map<string, { avatar: LiveAvatar; x: number; z: number; heading: number }> {
    const result = new Map<string, { avatar: LiveAvatar; x: number; z: number; heading: number }>();
    const latest = this.#latest;
    if (!latest) return result;
    const previous = new Map((this.#previous?.avatars ?? []).map((a) => [a.agentId, a]));
    const span = Math.max(1, latest.at - (this.#previous?.at ?? latest.at));
    const t = Math.min(1, Math.max(0, (nowMs - this.#receivedAt) / span));
    for (const a of latest.avatars) {
      const p = previous.get(a.agentId);
      result.set(a.animalId, p && p.animalId === a.animalId
        ? { avatar: a, x: p.x + (a.x - p.x) * t, z: p.z + (a.z - p.z) * t, heading: lerpAngle(p.heading, a.heading, t) }
        : { avatar: a, x: a.x, z: a.z, heading: a.heading });
    }
    return result;
  }

  /** Wild animals in a live chase, drawn between the last two updates like agents' animals. */
  wildPositions(nowMs: number): Map<string, { wild: LiveWild; x: number; z: number; heading: number }> {
    const result = new Map<string, { wild: LiveWild; x: number; z: number; heading: number }>();
    const latest = this.#latest;
    if (!latest?.wild) return result;
    const previous = new Map((this.#previous?.wild ?? []).map((w) => [w.animalId, w]));
    const span = Math.max(1, latest.at - (this.#previous?.at ?? latest.at));
    const t = Math.min(1, Math.max(0, (nowMs - this.#receivedAt) / span));
    for (const w of latest.wild) {
      const p = previous.get(w.animalId);
      result.set(w.animalId, p ? { wild: w, x: p.x + (w.x - p.x) * t, z: p.z + (w.z - p.z) * t, heading: lerpAngle(p.heading, w.heading, t) }
        : { wild: w, x: w.x, z: w.z, heading: w.heading });
    }
    return result;
  }

  /** Avatars (and wild animals in a live chase) as poses for the animal layer, over the recorded and checkpoint ones. */
  poses(nowMs: number, animals: ReadonlyMap<string, AnimalState>): Map<string, LivePose> {
    const result = new Map<string, LivePose>();
    for (const [animalId, p] of this.wildPositions(nowMs)) {
      const base = animals.get(animalId);
      if (!base) continue;
      const moving = p.wild.mode !== 'idle';
      const position = { x: p.x, z: p.z, heading: p.heading, moving };
      result.set(animalId, { kind: 'movement', animal: { ...base, position, state: WILD_STATE[p.wild.mode] },
        position, seconds: nowMs / 1000, clipSeconds: nowMs / 1000, partnerId: '', eventId: '', phase: WILD_STATE[p.wild.mode],
        ...(p.wild.mode === 'flee' || p.wild.mode === 'chase' ? { hurried: true } : {}) });
    }
    for (const [animalId, p] of this.positions(nowMs)) {
      const base = animals.get(animalId);
      if (!base) continue;
      const moving = p.avatar.moving;
      const position = { x: p.x, z: p.z, heading: p.heading, moving, ...(p.avatar.altitude ? { altitudeM: p.avatar.altitude } : {}) };
      const state = p.avatar.action === 'hunt' ? (p.avatar.gait === 'run' ? 'chasing' : 'stalking')
        : moving ? 'travelling' : ACTION_STATE[p.avatar.action];
      result.set(animalId, { kind: 'movement', animal: { ...base, position, state },
        position, seconds: nowMs / 1000, clipSeconds: nowMs / 1000, partnerId: '', eventId: '', phase: activityOf(p.avatar),
        ...(moving && p.avatar.gait === 'run' ? { hurried: true } : {}) });
    }
    return result;
  }

  /** Pulses the beams and draws each open's progress. Call every frame. */
  animate(seconds: number): void {
    const opening = new Map(this.avatars.filter((a) => a.opening).map((a) => [a.opening!.dropId, a.opening!.progress]));
    for (const [id, view] of this.#drops) {
      (view.beam.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.1 * Math.sin(seconds * 3);
      view.crate.rotation.y = seconds * 0.8;
      const progress = opening.get(id) ?? 0;
      view.progress.visible = progress > 0;
      if (progress > 0) {
        view.progress.geometry.dispose();
        view.progress.geometry = new THREE.RingGeometry(1.2, 1.5, 48, 1, 0, Math.PI * 2 * Math.min(1, progress)).rotateX(-Math.PI / 2);
      }
    }
  }

  #syncDrops(drops: LiveDrop[]): void {
    const wanted = new Set(drops.map((d) => d.id));
    for (const [id, view] of this.#drops) {
      if (wanted.has(id)) continue;
      this.root.remove(view.group); view.progress.geometry.dispose(); this.#drops.delete(id);
    }
    for (const d of drops) {
      let view = this.#drops.get(d.id);
      if (!view) {
        const group = new THREE.Group(), ring = new THREE.Mesh(this.#ringGeometry, this.#ringMaterial);
        const beam = new THREE.Mesh(this.#beamGeometry, this.#beamMaterial.clone()), crate = new THREE.Mesh(this.#crateGeometry, this.#crateMaterial);
        const progress = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.5, 48), this.#progressMaterial);
        group.name = `drop-${d.id}`; group.add(ring, beam, crate, progress); progress.visible = false;
        this.root.add(group);
        view = { group, ring, beam, crate, progress };
        this.#drops.set(d.id, view);
      }
      view.ring.scale.setScalar(d.hint.radius);
      view.ring.position.set(d.hint.x, this.groundAt(d.hint.x, d.hint.z) + 0.3, d.hint.z);
      const spotted = d.spotted;
      view.beam.visible = view.crate.visible = !!spotted;
      if (spotted) {
        const y = this.groundAt(spotted.x, spotted.z);
        for (const m of [view.beam, view.crate]) m.position.set(spotted.x, y, spotted.z);
        view.progress.position.set(spotted.x, y + 0.05, spotted.z);
      }
    }
  }
}
