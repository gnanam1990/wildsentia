import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { clipForObservedMotion, elephantTrunkReach, renderStateFor, replayClipTime,
  type ClimbVisualPhase, type FlightVisualPhase } from './animation.js';
import { PositionTracker, renderBaseY, type RenderPosition } from './space.js';
import type { AnimalState } from './protocol.js';
import { chooseVisible } from './lod.js';
import { RENDER_BUDGETS, type RenderTier } from './renderQuality.js';
import { visualFor, visualForAnimal } from './species.js';
import { characterScale, coatMultiplier } from './appearance.js';
import { separateBodies, type Body, type Obstacle, type ObstacleField } from './obstacles.js';
import type { LivePose } from './liveEncounters.js';
import { AnimalDots } from './animalDots.js';
import { elephantSurface } from './elephantSurface.js';

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
  visual: THREE.Object3D;
  footY: number;
  restRotationZ: number;
  needsCorpseGrounding: boolean;
  appearanceKey: string;
  materials: Array<{ material: THREE.MeshStandardMaterial; base: THREE.Color }>;
}

function variantKey(animal: AnimalState): string {
  return `${animal.speciesId}|${visualForAnimal(animal).model?.file ?? 'stand-in'}`;
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
  /** Ids whose model is being loaded. Without this, sync() would start a fresh load every frame. */
  readonly #pending = new Set<string>();
  readonly #ready = new Map<string, { animal: AnimalState; template: THREE.Group; variantKey: string }>();
  #wanted = new Set<string>();
  #wantedVariants = new Map<string, string>();

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

  constructor() {
    this.#dotLayer = new AnimalDots(AnimalLayer.MAX_DOTS); this.#dots = this.#dotLayer.mesh;
    this.root.add(this.#dots);
  }

  async #template(animal: AnimalState): Promise<THREE.Group> {
    const visual = visualForAnimal(animal);
    const key = variantKey(animal);
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
            return { root: gltf.scene, clips: source ? [...gltf.animations, elephantTrunkReach(source)] : gltf.animations };
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
    const key = variantKey(animal);
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

    const rig: Rig = { variantKey: key, group, mixer, actions, clipNames: clips.map((c) => c.name), playing: null,
      visual, footY: visual.position.y, restRotationZ: visual.rotation.z,
      needsCorpseGrounding: false, appearanceKey: '', materials };
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
    this.#wantedVariants = new Map([...visible].map(id => [id, variantKey(animals.get(id)!)]));
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
        this.#poseAt(rig, pose.hurried && shown === 'travelling' ? 'fleeing' : shown, pose.clipSeconds ?? pose.seconds,
          flightPhase, unknownAirborne, climbPhase);
      } else {
        const climbing = arboreal(animal.speciesId) && animal.locomotionMode === 'climb';
        const phase = climbing ? this.tracker.verticalPhaseAt(id, nowMs) : null;
        const elevated = climbing && (position.altitudeM ?? 0) > 0;
        const state = elevated && !position.moving && animal.state === 'travelling'
          ? 'resting' : renderStateFor(animal.state, position.moving);
        this.#animate(rig, state, phase, elevated && position.moving && phase === null);
      }
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
  syncReplay(animal: AnimalState, position: RenderPosition, seconds = 0): void {
    this.syncReplayGroup([{ animal, position }], seconds);
  }

  /** Paired encounter actors share a playhead; calling syncReplay twice would release one. */
  syncReplayGroup(subjects: Array<{ animal: AnimalState; position: RenderPosition }>, seconds = 0): void {
    this.#dotLayer.hide();
    const ids = new Set(subjects.map(({ animal }) => animal.id));
    this.#wanted = ids;
    this.#wantedVariants = new Map(subjects.map(({ animal }) => [animal.id, variantKey(animal)]));
    this.#prepareRigs([...ids]);
    for (const [id, rig] of [...this.#rigs]) {
      if (ids.has(id)) continue;
      this.#release(id, rig);
    }
    for (const { animal, position } of subjects) {
      void this.#ensureRig(animal);
      const rig = this.#rigs.get(animal.id);
      if (!rig) continue;
      this.#place(rig, position);
      rig.group.rotation.y = position.heading;
      this.#appearance(rig, animal);
      const unknownClimb = arboreal(animal.speciesId) && (position.altitudeM ?? 0) > 0 && position.moving;
      const state = arboreal(animal.speciesId) && (position.altitudeM ?? 0) > 0
        && !position.moving && animal.state === 'travelling' ? 'resting' : renderStateFor(animal.state, position.moving);
      this.#poseAt(rig, state, seconds, null, unknownClimb);
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
      // A carcass lies where it fell; scavengers gather round it rather than nudging it.
      if ((pose?.animal ?? animal).state === 'dead') { fixed.push({ x: position.x, z: position.z, radius: radius * 0.8 }); continue; }
      bodies.push({ id, x: position.x, z: position.z, heading: position.heading, radius,
        ...(pose?.partnerId ? { partnerId: pose.partnerId } : {}) });
    }
    if (bodies.length === 0) return;
    for (const [id, clear] of separateBodies(bodies, fixed, this.avoid)) {
      const position = positions.get(id)!;
      if (clear.x !== position.x || clear.z !== position.z) positions.set(id, { ...position, ...clear });
    }
  }

  #poseAt(rig: Rig, state: string, seconds: number, flightPhase: FlightVisualPhase | null = null,
    unknownAirborne = false, climbPhase: ClimbVisualPhase | null = null): void {
    const clip = clipForObservedMotion(state, rig.clipNames, flightPhase, unknownAirborne, climbPhase);
    rig.mixer?.stopAllAction();
    // No crossfade or wall-clock advance during a seek. Poses are illustrative, but stable.
    rig.playing = null;
    const action = clip === null ? undefined : rig.actions.get(clip);
    if (action) {
      action.reset().setEffectiveWeight(1).setLoop(THREE.LoopOnce, 1).play();
      action.clampWhenFinished = true;
      action.time = replayClipTime(state, action.getClip().duration, seconds);
      action.paused = true;
      rig.mixer?.update(0);
    }
    if (rig.needsCorpseGrounding) this.#groundCorpse(rig);
  }

  positionOf(id: string, nowMs: number): RenderPosition | null {
    return this.#renderPositions.get(id) ?? (this.tracker.has(id) ? this.tracker.positionAt(id, nowMs) : null);
  }

  update(deltaSeconds: number): void {
    for (const rig of this.#rigs.values()) rig?.mixer?.update(deltaSeconds);
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
    const wanted = clipForObservedMotion(state, rig.clipNames, null, unknownAirborne, climbPhase);
    // Never keep walking/eating after a state changes to one without a supported clip.
    if (wanted === null) {
      rig.mixer.stopAllAction(); rig.playing = null;
      if (rig.needsCorpseGrounding) this.#groundCorpse(rig);
      return;
    }
    if (wanted === rig.playing) return;

    const next = rig.actions.get(wanted);
    if (next === undefined) return;

    const previous = rig.playing === null ? null : rig.actions.get(rig.playing) ?? null;
    if (state === 'dead') { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
    else { next.setLoop(THREE.LoopRepeat, Infinity); next.clampWhenFinished = false; }
    next.reset().play();
    if (previous !== null) previous.crossFadeTo(next, 0.35, false);
    rig.playing = wanted;
  }

  #appearance(rig: Rig, animal: AnimalState): void {
    const key = `${animal.state}|${animal.sizeRatio ?? ''}|${animal.coatVariant ?? ''}|${animal.decayStage ?? ''}`;
    if (rig.appearanceKey === key) return;
    rig.appearanceKey = key;
    rig.group.scale.setScalar(characterScale(animal));
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
    rig.visual.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.dispose();
    });
    this.root.remove(rig.group);
    this.#rigs.delete(id);
  }
}
