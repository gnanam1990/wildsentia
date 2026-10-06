import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { actClipTime, clipForObservedMotion, clipForState, clipPhase, elephantTrunkReach, renderStateFor, replayClipTime, struggleClip, vigilance,
  type ClimbVisualPhase, type FlightVisualPhase, climbPose } from './animation.js';
import { PositionTracker, renderBaseY, type RenderPosition } from './space.js';
import type { AnimalState } from './protocol.js';
import { chooseVisible } from './lod.js';
import { RENDER_BUDGETS, type RenderTier } from './renderQuality.js';
import { visualFor, visualForAnimal } from './species.js';
import { onShore, type Pool } from './pools.js';
import { characterScale, coatMultiplier, markerSize } from './appearance.js';
import { separateBodies, type Body, type Obstacle, type ObstacleField } from './obstacles.js';
import type { LivePose } from './liveEncounters.js';
import { AnimalDots } from './animalDots.js';
import { elephantSurface } from './elephantSurface.js';
import { ACT_STATES } from './huntActs.js';
import { clipForGait, GaitClock, hipHeightM, isStrideClip, stateAtSpeed, strideCycles, strideRate } from './gait.js';

/**
 * A plain stand-in for a species with no rigged model yet: a body and a head in the species'
 * own colour and size. Honest about what it is, rather than borrowing another animal's shape.
 */
function standIn(colour: number): THREE.Group {
  const material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85, flatShading: true });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 3, 8), material);
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.62;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), material);
  head.position.set(0.72, 0.82, 0);
  const root = new THREE.Group();
  root.add(body, head);
  root.rotation.y = -Math.PI / 2; // face +z like the loaded models
  return root;
}

const arboreal = (speciesId: string): boolean => speciesId === 'langur' || speciesId === 'squirrel';

interface Rig {
  variantKey: string;
  group: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  actions: Map<string, THREE.AnimationAction>;
  clipNames: string[];
  playing: string | null;
  marker: THREE.Sprite;
  visual: THREE.Object3D;
  footY: number;
  restRotationZ: number;
  /** Nose-to-tail length of the placed model, in metres, for standing it upright on a trunk. */
  bodyLengthM: number;
  /** The model's own pose before a climb stood it upright; null when not climbing. */
  climbRest: { rotationX: number; z: number; y: number } | null;
  needsCorpseGrounding: boolean;
  /** Shown ground speed and stride clock, so legs keep pace with the ground. */
  gait: GaitClock;
  /** Hip height of the drawn animal, in metres, for its stride length. */
  hipM: number;
  /** Stable per-animal number: its own clip phase and look-up rhythm. */
  seed: number;
  /**
   * Whether it lifts its head to look round while feeding or drinking. The tiger feeds and
   * drinks crouched; blending toward its standing idle would stand it up and down.
   */
  looksUp: boolean;
  appearanceKey: string;
  materials: Array<{ material: THREE.MeshStandardMaterial; base: THREE.Color }>;
}

/** Stride cycles per clip, read once from the clip's own motion. */
const CYCLES = new WeakMap<THREE.AnimationClip, number>();
function cyclesOf(clip: THREE.AnimationClip): number {
  let cycles = CYCLES.get(clip);
  if (cycles === undefined) { cycles = strideCycles(clip); CYCLES.set(clip, cycles); }
  return cycles;
}

/** A stable small number per animal, to spread drinkers round a pool. */
function idSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function variantKey(animal: AnimalState, airborne = false): string {
  return `${animal.speciesId}|${visualForAnimal(animal, airborne).model?.file ?? 'stand-in'}`;
}

function markerTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(200,235,140,0.95)';
  ctx.beginPath(); ctx.arc(32, 32, 10, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(20,40,25,0.7)'; ctx.lineWidth = 3; ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Renders the animals the server reported. It holds no simulation state: position comes from
 * interpolating between the patches the server named, and the animation clip is chosen from
 * the server's `state` field.
 */
export class AnimalLayer {
  readonly root = new THREE.Group();
  readonly tracker = new PositionTracker();
  /** Obstacles near the camera that placed animals are drawn clear of; null draws them as recorded. */
  avoid: ObstacleField | null = null;
  /** People drawn in the scene; animals are drawn clear of them. */
  people: ReadonlyArray<Obstacle> = [];
  quality: RenderTier = 'balanced';
  #renderPositions = new Map<string, RenderPosition>();
  /** Set once the terrain is known, so animals stand on the ground rather than at sea level. */
  groundHeightAt: (x: number, z: number) => number = () => 0;

  readonly #templates = new Map<string, Promise<THREE.Group>>();
  readonly #rigs = new Map<string, Rig>();
  /** Seconds of drawn time, for each animal's own look-up rhythm while it feeds or drinks. */
  #clockSeconds = 0;
  /** Ids whose model is being loaded. Without this, sync() would start a fresh load every frame. */
  readonly #pending = new Set<string>();
  readonly #ready = new Map<string, { animal: AnimalState; template: THREE.Group; variantKey: string }>();
  readonly #markerTexture: THREE.Texture;
  #wanted = new Set<string>();
  #wantedVariants = new Map<string, string>();
  /** The drawn drinking pools; animals recorded at a pool's centre are drawn on its shore. */
  pools: Pool[] = [];
  /** Off in the clean (interface-hidden) view, so nothing floats over the followed animal. */
  markersVisible = true;
  /** Vultures in the air this frame: they are drawn with the rig that can spread its wings. */
  #airborne = new Set<string>();

  /** Read-only loading count for observer diagnostics and bounded render-lifecycle checks. */
  get pendingModelCount(): number { return this.#pending.size; }

  /**
   * Every animal too far away for a model is still shown: a dot in its species' colour, a
   * constant few pixels across, all in one draw call. Without it the forest looked empty past a
   * few hundred metres, and only whatever lived next to the camera — deer and boar — was seen.
   */
  readonly #dots: THREE.Points;
  readonly #dotLayer: AnimalDots;
  static readonly MAX_DOTS = 8000;

  /** The animal behind a dot a click landed on. */
  dotIdAt(index: number): string | undefined {
    return this.#dotLayer.idAt(index);
  }

  isDots(object: THREE.Object3D): boolean {
    return object === this.#dots;
  }

  constructor(marker: THREE.Texture = markerTexture()) {
    this.#markerTexture = marker;
    this.#dotLayer = new AnimalDots(AnimalLayer.MAX_DOTS); this.#dots = this.#dotLayer.mesh;
    this.root.add(this.#dots);
  }

  async #template(animal: AnimalState): Promise<THREE.Group> {
    const airborne = this.#airborne.has(animal.id);
    const visual = visualForAnimal(animal, airborne);
    const key = variantKey(animal, airborne);
    let pending = this.#templates.get(key);
    if (pending === undefined) {
      const loaded: Promise<{ root: THREE.Group; clips: THREE.AnimationClip[] }> = visual.model === null
        ? Promise.resolve({ root: standIn(visual.colour), clips: [] })
        : import('three/examples/jsm/loaders/GLTFLoader.js')
          .then(({ GLTFLoader }) => new GLTFLoader().loadAsync(visual.model!.file))
          .then((gltf) => {
            const source = ['/assets/animals/AsianElephantAdultMale.glb', '/assets/animals/AsianElephantAdultFemale.glb',
              '/assets/animals/AsianElephantCalf.glb'].includes(visual.model?.file ?? '')
              ? gltf.animations.find(clip => clip.name === 'SprayWater') : undefined;
            const clips = source ? [...gltf.animations, elephantTrunkReach(source)] : gltf.animations;
            // A downed prey's struggle, from its own death pose and gait (see struggleClip).
            const death = clips.find((c) => /^(death|dead)$/i.test(c.name));
            const gait = clips.find((c) => /^(gallop|run|walk)$/i.test(c.name)) ?? null;
            return { root: gltf.scene, clips: death && !clips.some((c) => c.name === 'Struggle') ? [...clips, struggleClip(death, gait)] : clips };
          });
      pending = loaded.then(({ root, clips }) => {
        // Turned before measuring, so the height and foot offset are of the model as it stands.
        root.rotation.y = visual.model?.yaw ?? root.rotation.y;
        const tint = visual.model?.tint;
        if (tint !== undefined) {
          // Recolour a borrowed model toward its species: a Shiba's coat to a dhole's rust.
          const tinted = (material: THREE.Material): THREE.Material => {
            const copy = material.clone() as THREE.MeshStandardMaterial;
            copy.color?.multiply(new THREE.Color(tint));
            return copy;
          };
          root.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tinted) : tinted(mesh.material);
          });
        }
        root.userData.clips = clips;
        const box = new THREE.Box3().setFromObject(root);
        const height = Math.max(box.max.y - box.min.y, 0.001);
        // A long raised tail must not shrink the animal's shoulder height.
        root.userData.scale = visual.heightM / (visual.model?.referenceHeightM ?? height);
        root.userData.footOffset = box.min.y;
        return root;
      });
      this.#templates.set(key, pending);
    }
    return pending;
  }

  async #ensureRig(animal: AnimalState): Promise<void> {
    const key = variantKey(animal, this.#airborne.has(animal.id));
    const existing = this.#rigs.get(animal.id);
    if (existing?.variantKey === key) return;
    if (existing) this.#release(animal.id, existing);
    const ready = this.#ready.get(animal.id);
    if (ready?.variantKey === key || this.#pending.has(animal.id)) return;
    if (ready) this.#ready.delete(animal.id);
    this.#pending.add(animal.id);

    let template: THREE.Group;
    try {
      template = await this.#template(animal);
    } catch (error) {
      console.error(`could not load a model for ${animal.speciesId}`, error);
      this.#pending.delete(animal.id);
      return;
    }
    // Loads can finish after a follow/quality/replay change. Do not clone, allocate skins or
    // publish an obsolete model merely because its shared species download completed.
    if (!this.#wanted.has(animal.id) || this.#wantedVariants.get(animal.id) !== key) {
      this.#pending.delete(animal.id); return;
    }
    this.#pending.delete(animal.id);
    this.#ready.set(animal.id, { animal, template, variantKey: key });
  }

  /** A shared download can resolve 120 animals at once. Never clone all their skins/materials
   * in that microtask burst; stage at most two per sync, with watched actors first. */
  #prepareRigs(priority: readonly (string | null | undefined)[]): void {
    for (const [id, ready] of this.#ready) {
      if (!this.#wanted.has(id) || this.#wantedVariants.get(id) !== ready.variantKey) this.#ready.delete(id);
    }
    const order = new Set([...priority, ...this.#ready.keys()]);
    const started = performance.now(); let built = 0;
    for (const id of order) {
      if (!id) continue;
      const ready = this.#ready.get(id);
      if (!ready) continue;
      this.#ready.delete(id);
      this.#createRig(ready.animal, ready.template, ready.variantKey);
      if (++built === 2 || performance.now() - started >= 2) break;
    }
  }

  #createRig(animal: AnimalState, template: THREE.Group, key: string): void {
    const visual = cloneSkeleton(template);
    const scale = template.userData.scale as number;
    visual.scale.setScalar(scale);
    visual.position.y = -(template.userData.footOffset as number) * scale;
    const materials: Rig['materials'] = [];
    visual.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true; mesh.receiveShadow = true;
        const own = (source: THREE.Material): THREE.Material => {
          const material = source.clone() as THREE.MeshStandardMaterial;
          if (material.color) materials.push({ material, base: material.color.clone() });
          return material;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
      }
    });
    // The template's material is cloned for each animal above. Shader hooks do not
    // survive Material.clone(), so grade the owned copy rather than the template.
    if (visualForAnimal(animal).model?.file?.startsWith('/assets/animals/AsianElephant'))
      elephantSurface(visual, false);

    const group = new THREE.Group();
    group.visible = false; // The next sync places it at a validated pose before showing it.
    group.name = animal.id;
    group.add(visual);

    const clips = (template.userData.clips ?? []) as THREE.AnimationClip[];
    const actions = new Map<string, THREE.AnimationAction>();
    let mixer: THREE.AnimationMixer | null = null;
    if (clips.length > 0) {
      mixer = new THREE.AnimationMixer(visual);
      for (const clip of clips) actions.set(clip.name, mixer.clipAction(clip));
    }

    const marker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.#markerTexture, depthTest: false, transparent: true }),
    );
    // Sized and placed for the animal: a fixed 3 m marker hid a dhole entirely.
    const height = visualFor(animal.speciesId).heightM;
    const size = markerSize(height);
    marker.scale.set(size, size, 1);
    marker.position.y = height + size * 0.9;
    marker.visible = false;
    group.add(marker);

    const bodyLengthM = new THREE.Box3().setFromObject(visual).getSize(new THREE.Vector3()).z;
    const rig: Rig = { variantKey: key, group, mixer, actions, clipNames: clips.map((c) => c.name), playing: null, marker,
      visual, footY: visual.position.y, restRotationZ: visual.rotation.z, bodyLengthM, climbRest: null,
      needsCorpseGrounding: false, gait: new GaitClock(), hipM: hipHeightM(height * characterScale(animal)), seed: idSeed(animal.id), looksUp: animal.speciesId !== 'tiger',
      appearanceKey: '', materials };
    this.#pending.delete(animal.id);
    this.#rigs.set(animal.id, rig);
  }

  /**
   * Applies the server's animal set. Every animal is tracked, but only those near where the
   * camera is looking get a model; the rest are released and rebuilt when the camera returns.
   */
  sync(
    animals: ReadonlyMap<string, AnimalState>,
    nowMs: number,
    followedId: string | null,
    focus: { x: number; z: number },
    recorded: ReadonlyMap<string, LivePose> = new Map(),
  ): void {
    const positions = new Map<string, RenderPosition>();
    for (const animal of animals.values()) {
      const pose = recorded.get(animal.id);
      if (pose) {
        this.tracker.placeRecorded(animal.id, pose.position, nowMs);
        positions.set(animal.id, pose.position);
        continue;
      }
      this.tracker.update(animal.id, animal.patchId, nowMs, animal.position, animal.altitudeM);
      positions.set(animal.id, this.tracker.positionAt(animal.id, nowMs));
    }
    const budget = RENDER_BUDGETS[this.quality];
    const visible = chooseVisible(positions, focus, followedId, { max: budget.animalModels, radiusM: budget.animalRadius });
    const partner = followedId === null ? undefined : recorded.get(followedId)?.partnerId;
    if (partner && positions.has(partner)) visible.add(partner);
    this.#wanted = visible;
    this.#airborne = new Set([...visible].filter((id) => animals.get(id)!.speciesId === 'vulture'
      && ((positions.get(id)!.altitudeM ?? 0) > 0.5 || recorded.get(id)?.flightVisualPhase !== undefined)));
    this.#wantedVariants = new Map([...visible].map(id => [id, variantKey(animals.get(id)!, this.#airborne.has(id))]));
    this.#renderPositions = positions;
    this.#prepareRigs([followedId, partner]);

    this.#keepApart(visible, animals, positions, recorded);

    for (const id of visible) {
      const animal = animals.get(id)!;
      void this.#ensureRig(animal);
      const rig = this.#rigs.get(id);
      if (!rig) continue;
      const position = positions.get(id)!;
      this.#place(rig, position);
      rig.gait.observe(position.x, position.z, nowMs / 1000, rig.hipM);
      const pose = recorded.get(id);
      // A delayed route must not borrow a later checkpoint's feeding/death appearance or clip.
      this.#appearance(rig, pose?.animal ?? animal);
      if (pose) {
        rig.group.rotation.y = position.heading;
        const flightPhase = animal.speciesId === 'vulture' ? pose.flightVisualPhase ?? null : null;
        const climbPhase = arboreal(animal.speciesId) ? pose.climbVisualPhase ?? null : null;
        const unknownAirborne = pose.kind === 'movement' && (position.altitudeM ?? 0) > 0
          && (animal.speciesId === 'vulture' && flightPhase === null
            || arboreal(animal.speciesId) && position.moving && climbPhase === null);
        const shown = renderStateFor(pose.animal.state, position.moving);
        this.#climb(rig, animal.speciesId, climbPhase);
        this.#poseAt(rig, pose.hurried && shown === 'travelling' ? 'fleeing' : shown, pose.clipSeconds ?? pose.seconds,
          flightPhase, unknownAirborne, climbPhase, pose.act, pose.actWeight);
      } else {
        const climbing = arboreal(animal.speciesId) && animal.locomotionMode === 'climb';
        const phase = climbing ? this.tracker.verticalPhaseAt(id, nowMs) : null;
        const elevated = climbing && (position.altitudeM ?? 0) > 0;
        const state = elevated && !position.moving && animal.state === 'travelling'
          ? 'resting' : renderStateFor(animal.state, position.moving);
        this.#climb(rig, animal.speciesId, phase);
        this.#animate(rig, state, phase, elevated && position.moving && phase === null);
      }
      rig.marker.visible = this.markersVisible && (id === followedId || id === partner);
    }

    // Keep pending actors selectable as dots until their placed model is actually available.
    this.#dotLayer.sync(animals, positions, new Set([...visible].filter((id) => this.#rigs.has(id))), this.groundHeightAt);

    this.tracker.forgetAllExcept(new Set(animals.keys()));
    for (const [id, rig] of [...this.#rigs]) {
      if (visible.has(id)) continue;
      this.#release(id, rig);
    }
  }

  /**
   * Shows one animal alone, at a position the replay computed from its recorded track. Every
   * other model is released while a life is replayed; they come back when live sync resumes.
   */
  syncReplay(animal: AnimalState, position: RenderPosition, seconds = 0, climbPhase: ClimbVisualPhase | null = null): void {
    this.syncReplayGroup([{ animal, position, climbPhase }], seconds);
  }

  /** Paired encounter actors share a playhead; calling syncReplay twice would release one. */
  syncReplayGroup(subjects: Array<{ animal: AnimalState; position: RenderPosition; climbPhase?: ClimbVisualPhase | null;
    act?: number; actWeight?: number }>, seconds = 0): void {
    this.#dotLayer.hide();
    const ids = new Set(subjects.map(({ animal }) => animal.id));
    this.#wanted = ids;
    this.#wantedVariants = new Map(subjects.map(({ animal }) => [animal.id, variantKey(animal)]));
    this.#prepareRigs([...ids]);
    for (const [id, rig] of [...this.#rigs]) {
      if (ids.has(id)) continue;
      this.#release(id, rig);
    }
    for (const { animal, position, climbPhase = null, act, actWeight } of subjects) {
      void this.#ensureRig(animal);
      const rig = this.#rigs.get(animal.id);
      if (!rig) continue;
      this.#place(rig, position);
      rig.gait.observe(position.x, position.z, seconds, rig.hipM);
      rig.group.rotation.y = position.heading;
      this.#appearance(rig, animal);
      const phase = arboreal(animal.speciesId) ? climbPhase : null;
      const unknownClimb = arboreal(animal.speciesId) && (position.altitudeM ?? 0) > 0 && position.moving && phase === null;
      const state = arboreal(animal.speciesId) && (position.altitudeM ?? 0) > 0
        && !position.moving && animal.state === 'travelling' ? 'resting' : renderStateFor(animal.state, position.moving);
      this.#climb(rig, animal.speciesId, phase);
      this.#poseAt(rig, state, seconds, null, unknownClimb, phase, act, actWeight);
      rig.marker.visible = this.markersVisible;
    }
  }

  /**
   * Draws nearby ground animals clear of each other, of people and of trunks and boulders
   * (presentation only; see separateBodies). A langur or squirrel climbing a trunk must reach
   * it, and a vulture in the air is above it all, so they are left where they are recorded.
   */
  #keepApart(visible: ReadonlySet<string>, animals: ReadonlyMap<string, AnimalState>,
    positions: Map<string, RenderPosition>, recorded: ReadonlyMap<string, LivePose>): void {
    const bodies: Body[] = [], fixed: Obstacle[] = [...this.people];
    for (const id of visible) {
      const animal = animals.get(id), position = positions.get(id);
      if (!animal || !position || (position.altitudeM ?? 0) > 0 || animal.speciesId === 'vulture') continue;
      const pose = recorded.get(id);
      if (arboreal(animal.speciesId) && (animal.locomotionMode === 'climb' || pose?.climbVisualPhase !== undefined)) continue;
      const radius = visualFor(animal.speciesId).heightM * 0.5 * characterScale(animal);
      const shown = pose?.animal ?? animal;
      const ashore = onShore(position, this.pools, radius, shown.state === 'drinking', idSeed(id));
      if (ashore !== position) positions.set(id, ashore);
      // A carcass lies where it fell; scavengers gather round it rather than nudging it.
      if (shown.state === 'dead') { fixed.push({ x: ashore.x, z: ashore.z, radius: radius * 0.8 }); continue; }
      bodies.push({ id, x: ashore.x, z: ashore.z, heading: ashore.heading, radius,
        ...(pose?.partnerId ? { partnerId: pose.partnerId } : {}) });
    }
    if (bodies.length === 0) return;
    const sizes = new Map(bodies.map((b) => [b.id, b.radius]));
    for (const [id, clear] of separateBodies(bodies, fixed, this.avoid)) {
      const position = positions.get(id)!;
      if (clear.x === position.x && clear.z === position.z) continue;
      // Making room for a neighbour must not step an animal back onto the water.
      const shown = recorded.get(id)?.animal ?? animals.get(id)!;
      positions.set(id, onShore({ ...position, ...clear }, this.pools, sizes.get(id)!, shown.state === 'drinking', idSeed(id)));
    }
  }

  #poseAt(rig: Rig, state: string, seconds: number, flightPhase: FlightVisualPhase | null = null,
    unknownAirborne = false, climbPhase: ClimbVisualPhase | null = null, act?: number, actWeight = 1): void {
    const grounded = flightPhase === null && climbPhase === null && !unknownAirborne;
    if (grounded) state = stateAtSpeed(state, rig.gait);
    const clip = (grounded ? clipForGait(state, rig.gait.gait, rig.clipNames) : null)
      ?? clipForObservedMotion(state, rig.clipNames, flightPhase, unknownAirborne, climbPhase);
    rig.mixer?.stopAllAction();
    // No crossfade or wall-clock advance during a seek. Poses are illustrative, but stable.
    rig.playing = null;
    const action = clip === null ? undefined : rig.actions.get(clip);
    if (action) {
      action.reset().setEffectiveWeight(1).setLoop(THREE.LoopOnce, 1).play();
      action.clampWhenFinished = true;
      const source = action.getClip();
      // A stride is sampled from a clock run at the pace of the ground covered, not the playhead.
      action.time = act !== undefined && ACT_STATES.has(state) ? actClipTime(state, source.duration, act)
        : grounded && isStrideClip(source.name) && rig.gait.speedMs > 0
        ? rig.gait.advance(strideRate(source, cyclesOf(source), rig.gait.speedMs, rig.hipM), source.duration)
        : replayClipTime(state, source.duration, seconds + clipPhase(rig.seed, source.duration));
      action.paused = true;
      // A struggling prey weakens: its kicks fade toward the stillness of its death pose.
      const lying = state === 'struggling' && actWeight < 1 ? clipForState('dead', rig.clipNames) : null;
      const still = lying === null || lying === clip ? undefined : rig.actions.get(lying);
      if (still) {
        still.reset().setEffectiveWeight(1 - actWeight).setLoop(THREE.LoopOnce, 1).play();
        still.clampWhenFinished = true; still.time = still.getClip().duration; still.paused = true;
        action.setEffectiveWeight(actWeight);
      }
      // A drinking or grazing animal lifts its head to look round now and then, blended in.
      const look = grounded && rig.looksUp ? vigilance(state, seconds, rig.seed) : 0;
      const alertClip = look > 0 ? clipForState('standing', rig.clipNames) : null;
      const alert = alertClip === null || alertClip === clip ? undefined : rig.actions.get(alertClip);
      if (alert) {
        alert.reset().setEffectiveWeight(look).setLoop(THREE.LoopRepeat, Infinity).play();
        alert.time = replayClipTime('standing', alert.getClip().duration, seconds + clipPhase(rig.seed, alert.getClip().duration));
        alert.paused = true;
        action.setEffectiveWeight(1 - look);
      }
      rig.mixer?.update(0);
    }
    if (rig.needsCorpseGrounding) this.#groundCorpse(rig);
  }

  positionOf(id: string, nowMs: number): RenderPosition | null {
    return this.#renderPositions.get(id) ?? (this.tracker.has(id) ? this.tracker.positionAt(id, nowMs) : null);
  }

  update(deltaSeconds: number): void {
    this.#clockSeconds += deltaSeconds;
    for (const rig of this.#rigs.values()) rig?.mixer?.update(deltaSeconds);
  }

  /** Upright against the trunk while a recorded climb plays; back on its feet otherwise. */
  #climb(rig: Rig, speciesId: string, phase: ClimbVisualPhase | null): void {
    // Only a climb touches the pose. A model's own root rotation (an export's axis fix, a yaw)
    // and corpse grounding are kept, and restored exactly when the climb ends.
    if (phase === null) {
      if (rig.climbRest === null) return;
      rig.visual.rotation.x = rig.climbRest.rotationX;
      rig.visual.position.z = rig.climbRest.z;
      rig.visual.position.y = rig.climbRest.y;
      rig.climbRest = null;
      return;
    }
    rig.climbRest ??= { rotationX: rig.visual.rotation.x, z: rig.visual.position.z, y: rig.visual.position.y };
    const { pitch, back, lift } = climbPose(speciesId, phase, rig.bodyLengthM);
    rig.visual.rotation.x = rig.climbRest.rotationX + pitch;
    rig.visual.position.z = rig.climbRest.z + back;
    rig.visual.position.y = rig.climbRest.y + lift;
  }

  #place(rig: Rig, position: RenderPosition): void {
    if (rig.group.parent === null) this.root.add(rig.group);
    rig.group.visible = true;
    rig.group.position.set(position.x, renderBaseY(position, this.groundHeightAt), position.z);
    const current = rig.group.rotation.y;
    const diff = ((position.heading - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    rig.group.rotation.y = current + diff * 0.1;
  }

  #animate(rig: Rig, state: string, climbPhase: ClimbVisualPhase | null = null,
    unknownAirborne = false): void {
    if (rig.mixer === null) return;
    const grounded = climbPhase === null && !unknownAirborne;
    if (grounded) state = stateAtSpeed(state, rig.gait);
    if (grounded && rig.looksUp && vigilance(state, this.#clockSeconds, rig.seed) > 0.5) state = 'standing';
    const wanted = (grounded ? clipForGait(state, rig.gait.gait, rig.clipNames) : null)
      ?? clipForObservedMotion(state, rig.clipNames, null, unknownAirborne, climbPhase);
    // Never keep walking/eating after a state changes to one without a supported clip.
    if (wanted === null) {
      rig.mixer.stopAllAction(); rig.playing = null;
      if (rig.needsCorpseGrounding) this.#groundCorpse(rig);
      return;
    }
    if (wanted === rig.playing) { this.#pace(rig, wanted, grounded); return; }

    const next = rig.actions.get(wanted);
    if (next === undefined) return;

    const previous = rig.playing === null ? null : rig.actions.get(rig.playing) ?? null;
    if (state === 'dead') { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
    else { next.setLoop(THREE.LoopRepeat, Infinity); next.clampWhenFinished = false; }
    next.reset().play();
    // Animals changing state together (at an hour change) must not then move in unison.
    if (state !== 'dead') next.time = clipPhase(rig.seed, next.getClip().duration);
    if (previous !== null) previous.crossFadeTo(next, 0.35, false);
    rig.playing = wanted;
    this.#pace(rig, wanted, grounded);
  }

  /** A stride clip turns over at the rate the animal's shown speed needs; anything else at its own. */
  #pace(rig: Rig, clip: string, grounded: boolean): void {
    const action = rig.actions.get(clip);
    if (!action) return;
    const source = action.getClip();
    const wanted = grounded && isStrideClip(clip) && rig.gait.speedMs > 0
      ? strideRate(source, cyclesOf(source), rig.gait.speedMs, rig.hipM) : 1;
    // Eased, so a change of pace is not a visible jolt in the legs.
    action.timeScale += (wanted - action.timeScale) * 0.15;
  }

  #appearance(rig: Rig, animal: AnimalState): void {
    const key = `${animal.state}|${animal.sizeRatio ?? ''}|${animal.coatVariant ?? ''}|${animal.decayStage ?? ''}`;
    if (rig.appearanceKey === key) return;
    rig.appearanceKey = key;
    rig.group.scale.setScalar(characterScale(animal));
    rig.hipM = hipHeightM(visualFor(animal.speciesId).heightM * characterScale(animal));
    const decay = animal.decayStage ?? 0;
    for (const { material, base } of rig.materials) {
      material.color.copy(base).multiplyScalar(coatMultiplier(animal.coatVariant));
      if (decay > 0) material.color.lerp(new THREE.Color(0x716853), Math.min(0.85, decay * 0.16));
    }
    // An unrigged corpse rests on its side. Ground the rotated mesh from its actual
    // bounds; a shoulder-height fraction can leave a large elephant hovering or buried.
    const hasDeath = rig.clipNames.some((name) => /^(death|dead)$/i.test(name));
    if (animal.state === 'dead' && !hasDeath) {
      rig.visual.rotation.z = Math.PI / 2;
      rig.visual.position.y = rig.footY;
      rig.needsCorpseGrounding = true;
      if (rig.mixer === null) this.#groundCorpse(rig);
    } else {
      rig.visual.rotation.z = rig.restRotationZ; rig.visual.position.y = rig.footY;
      rig.needsCorpseGrounding = false;
    }
  }

  #groundCorpse(rig: Rig): void {
    rig.group.updateMatrixWorld(true);
    const bottom = new THREE.Box3().setFromObject(rig.visual).min.y;
    if (Number.isFinite(bottom) && rig.group.scale.y > 0)
      rig.visual.position.y += (rig.group.position.y - bottom) / rig.group.scale.y;
    rig.needsCorpseGrounding = false;
  }

  #release(id: string, rig: Rig): void {
    rig.mixer?.stopAllAction();
    rig.mixer?.uncacheRoot(rig.visual);
    for (const { material } of rig.materials) material.dispose();
    rig.marker.material.dispose();
    rig.visual.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.dispose();
    });
    this.root.remove(rig.group);
    this.#rigs.delete(id);
  }
}
