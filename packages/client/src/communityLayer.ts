import * as THREE from 'three';
import type { CommunityState, LiveEncounterFrame } from '@vana/shared';
import { HumanLayer } from './humans.js';
import type { RenderTier } from './renderQuality.js';
import { CommunityPlayback, humanPlaybackPose, type HumanPlaybackPose } from './communityPlayback.js';
import type { HistoricHumanFrame } from './humanHistoryReplay.js';

/** Recorded construction and people; illustrative poses never advance the world. */
export class CommunityLayer {
  readonly root = new THREE.Group();
  readonly #box = new THREE.BoxGeometry(1, 1, 1);
  readonly #wood = new THREE.MeshStandardMaterial({ color: '#65543e', roughness: 1 });
  readonly #fibre = new THREE.MeshStandardMaterial({ color: '#887957', roughness: 1 });
  readonly #posts = new THREE.InstancedMesh(this.#box, this.#wood, 4);
  readonly #beams = new THREE.InstancedMesh(this.#box, this.#wood, 4);
  readonly #walls = new THREE.InstancedMesh(this.#box, this.#fibre, 5);
  readonly #roof = new THREE.InstancedMesh(this.#box, this.#fibre, 2);
  readonly #debris = new THREE.InstancedMesh(this.#box, this.#wood, 3);
  readonly #humans = new HumanLayer();
  readonly #playback = new CommunityPlayback();
  readonly #matrix = new THREE.Object3D();
  #historic: HistoricHumanFrame | null = null;
  #personIds = new Set<string>();
  #hasCommunity = false;
  #replaying = false;
  constructor() {
    this.root.name = 'community-construction';
    this.#posts.name = 'home-posts'; this.#beams.name = 'home-beams'; this.#walls.name = 'home-walls'; this.#roof.name = 'home-roof';
    this.#debris.name = 'illustrative-collapse-debris';
    for (const mesh of [this.#posts, this.#beams, this.#walls, this.#roof, this.#debris]) {
      mesh.castShadow = true; mesh.receiveShadow = true; this.root.add(mesh);
    }
    this.root.add(this.#humans.root); this.root.visible = false;
  }
  setReplay(replaying: boolean): void { this.#replaying = replaying; this.root.visible = this.#hasCommunity && !replaying; }
  /** Presentation-only historic selection; never writes the current community or its live clock. */
  setHistoricFrame(frame: HistoricHumanFrame | null): void { this.#historic = frame; }
  get showingHistoricFrame(): boolean { return this.#historic?.source === 'recorded'; }
  #historicPoses(): Map<string, HumanPlaybackPose> {
    const frame = this.#historic;
    return frame?.source === 'recorded' && frame.sample && frame.secondsInWindow !== null && this.#personIds.has(frame.personId)
      ? new Map([[frame.personId, humanPlaybackPose(frame.sample, frame.secondsInWindow)]]) : new Map();
  }
  applyRecording(state: CommunityState | null | undefined, frame: LiveEncounterFrame | null, receivedAt: number): void {
    this.#playback.apply(state, frame, receivedAt);
  }
  positionOf(id: string, now: number, reducedMotion: boolean): ReturnType<HumanLayer['positionOf']> {
    // A Watch button can exit historical replay before the next render makes this root visible.
    if (!this.#hasCommunity) return null;
    if (this.#historic) return this.#historic.source === 'recorded' && this.#historic.personId === id
      && this.#personIds.has(id) ? this.#humans.positionOf(id, this.#historicPoses()) : null;
    return this.#humans.positionOf(id, this.#playback.poses(now, reducedMotion));
  }
  update(dt: number, camera: THREE.Vector3, tier: RenderTier, reducedMotion: boolean, now = performance.now(), preferredId: string | null = null): void {
    const historic = this.#historic, historicPoses = this.#historicPoses();
    const visible = this.root.visible && (!historic || historicPoses.size > 0);
    this.#humans.root.visible = visible;
    this.#humans.update(dt, camera, tier, reducedMotion, visible,
      historic ? historicPoses : this.#playback.poses(now, reducedMotion), preferredId,
      historic?.personId ?? null, historic !== null);
  }
  playbackNotice(now: number, reducedMotion: boolean): string {
    if (!this.root.visible) return '';
    const historic = this.#historic;
    if (historic) {
      if (historic.source === 'loading') return 'Loading saved person movement. No historical position is shown yet.';
      if (historic.source === 'unavailable') return 'No saved movement available for this person at this checkpoint. Historical position unknown.';
      if (historic.source === 'gap') return 'No saved person position at this recorded time. People are hidden across the recording gap.';
      if (!this.#personIds.has(historic.personId)) return 'Saved movement exists, but this person is absent from the current scene; no 3D proxy is shown.';
      return 'Saved hourly person movement. Only this person is shown; rig and task pose are illustrative. Building and terrain remain at the newer checkpoint.';
    }
    if (!this.#humans.nearby) return '';
    return this.#playback.active(now, reducedMotion)
      ? 'Villagers nearby walk their recorded paths, an hour behind the latest checkpoint; poses are illustrative.'
      : 'Villagers nearby stand where the last checkpoint saw them.';
  }
  sync(state: CommunityState | null | undefined, ground: (x: number, z: number) => number): void {
    this.#hasCommunity = !!state; this.root.visible = !!state && !this.#replaying;
    this.#personIds = new Set(state?.people.map(p => p.id) ?? []);
    this.#humans.sync(state?.people ?? [], ground);
    if (!state) return;
    const { x, z } = state.building.position, base = ground(x, z), stage = state.building.stage;
    // Read recorded retained materials only. Shrinking panel coverage is an abstract wear
    // cue, not local damage simulation, structural engineering or finished destruction art.
    const weathered = state.version >= 4 && stage === 'occupied';
    const wood = weathered ? Math.sqrt(Math.max(0, Math.min(1, state.building.materials.timberKg / 96))) : 1;
    const fibre = weathered ? Math.max(0, Math.min(1, state.building.materials.fibreKg / 72)) : 1;
    const set = (mesh: THREE.InstancedMesh, i: number, px: number, py: number, pz: number, sx: number, sy: number, sz: number, tilt = 0) => {
      this.#matrix.position.set(px, py, pz); this.#matrix.scale.set(sx, sy, sz); this.#matrix.rotation.set(tilt, 0, 0);
      this.#matrix.updateMatrix(); mesh.setMatrixAt(i, this.#matrix.matrix);
    };
    const corners = [[-2.5, -2], [2.5, -2], [-2.5, 2], [2.5, 2]];
    for (const [i, corner] of corners.entries()) {
      const px = x + corner[0]!, pz = z + corner[1]!, foot = ground(px, pz) - .15;
      const top = stage === 'site' ? foot + .6 : Math.max(foot + .6, base + 2.8);
      set(this.#posts, i, px, (top + foot) / 2, pz, .16 * wood, top - foot, .16 * wood);
    }
    set(this.#beams, 0, x, base + 2.7, z - 2, 5.2, .2 * wood, .16 * wood);
    set(this.#beams, 1, x, base + 2.7, z + 2, 5.2, .2 * wood, .16 * wood);
    set(this.#beams, 2, x - 2.5, base + 2.7, z, .16 * wood, .2 * wood, 4.2);
    set(this.#beams, 3, x + 2.5, base + 2.7, z, .16 * wood, .2 * wood, 4.2);
    // Front wall has a real doorway; construction does not create a sealed collision box.
    set(this.#walls, 0, x, base + 1.4, z - 2, 5 * fibre, 2.5, .12);
    set(this.#walls, 1, x - 2.5, base + 1.4, z, .12, 2.5, 4 * fibre);
    set(this.#walls, 2, x + 2.5, base + 1.4, z, .12, 2.5, 4 * fibre);
    set(this.#walls, 3, x - 1.6, base + 1.4, z + 2, 1.8 * fibre, 2.5, .12);
    set(this.#walls, 4, x + 1.6, base + 1.4, z + 2, 1.8 * fibre, 2.5, .12);
    set(this.#roof, 0, x, base + 3.3, z - 1.15, 6 * fibre, .18, 2.6, -.44);
    set(this.#roof, 1, x, base + 3.3, z + 1.15, 6 * fibre, .18, 2.6, .44);
    const collapsed = state.version >= 8 && (state.building.maintenance?.collapses ?? 0)
      > (state.building.maintenance?.rebuildsCompleted ?? 0);
    set(this.#debris, 0, x - 1.2, base + .16, z - 1.2, 3.2, .24, .23, .12);
    set(this.#debris, 1, x + 1.1, base + .12, z + .7, 2.8, .2, .18, -.3);
    set(this.#debris, 2, x + .15, base + .09, z - .7, 1.8, .15, .25, .28);
    this.#beams.visible = stage !== 'site';
    this.#walls.visible = ['walls', 'roof', 'occupied'].includes(stage);
    this.#roof.visible = ['roof', 'occupied'].includes(stage);
    this.#debris.visible = collapsed;
    for (const mesh of [this.#posts, this.#beams, this.#walls, this.#roof, this.#debris]) {
      mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
    }
  }
  dispose(): void {
    for (const mesh of [this.#posts, this.#beams, this.#walls, this.#roof, this.#debris]) mesh.dispose();
    this.#box.dispose(); this.#wood.dispose(); this.#fibre.dispose();
    this.#humans.dispose(); this.root.clear(); this.root.removeFromParent();
  }
}
