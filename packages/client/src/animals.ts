import * as THREE from 'three';
import { ContactShadows, standingSoles, type ContactSpot, type Sole } from './contactShadows.js';
import { applyFurLook } from './furLook.js';
import { DrinkingRipple } from './drinkingRipple.js';
import { stabilizeSkinning } from './stableSkinning.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { bankAngle, leapingClip, actClipTime, climbs, clipForObservedMotion, clipForState, clipPhase, elephantTrunkReach, renderStateFor, replayClipTime, struggleClip, vigilance,
  type ClimbVisualPhase, type FlightVisualPhase, climbPose, flies, swimmingClip } from './animation.js';
import { PositionTracker, renderBaseY, swimBaseY, type RenderPosition } from './space.js';
import type { AnimalState } from './protocol.js';
import { chooseVisible } from './lod.js';
import { RENDER_BUDGETS, type RenderTier } from './renderQuality.js';
import { visualFor, visualForAnimal } from './species.js';
import { onShore, type Pool, HUNTERS, shoreSides } from './pools.js';
import { inCrown, spreadInCrowns, type CrownPlace, type PerchSubject } from './crownPerch.js';
import { CrownLimbs } from './crownLimbs.js';
import { characterScale, coatMultiplier } from './appearance.js';
import { separateBodies, type Body, type Obstacle, type ObstacleField } from './obstacles.js';
import type { LivePose } from './liveEncounters.js';
import { AnimalDots } from './animalDots.js';
import { elephantSurface } from './elephantSurface.js';
import { ACT_STATES } from './huntActs.js';
import { clipForGait, GaitClock, hipHeightM, isStrideClip, stateAtSpeed, strideCeiling, strideCycles, strideRate } from './gait.js';

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

const arboreal = climbs;

interface Rig {
  variantKey: string;
  speciesId: string;
  group: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  actions: Map<string, THREE.AnimationAction>;
  clipNames: string[];
  playing: string | null;
  visual: THREE.Object3D;
  footY: number;
  restRotationZ: number;
  /** Nose-to-tail length of the placed model, in metres, for standing it upright on a trunk. */
  bodyLengthM: number;
  soles: Sole[];
  /** The model's own pose before a climb stood it upright; null when not climbing. */
  climbRest: { rotationX: number; z: number; y: number } | null;
  needsCorpseGrounding: boolean;
  /** Shown ground speed and stride clock, so legs keep pace with the ground. */
  gait: GaitClock;
  /** Hip height of the drawn animal, in metres, for its stride length. */
  hipM: number;
  /** In water deeper than it stands at the hip (Congo rivers and flood): it swims. */
  swimming: boolean;
  /** Stable per-animal number: its own clip phase and look-up rhythm. */
  seed: number;
  /**
   * Whether it lifts its head to look round while feeding or drinking. The big cats (on the
   * tiger rig) feed and drink crouched; blending toward a standing idle would stand them up and down.
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
  /** The water surface where an animal stands (the Congo's rivers and flood), or null on dry ground. */
  waterSurfaceAt: ((x: number, z: number) => number | null) | null = null;

  /** A far animal's dot stands on the water where there is water (on the riverbed it was hidden
   * under the river); rebuilt only when the ground or the water changes, so the dots know to move. */
  #dotSampler: { ground: unknown; water: unknown; at: (x: number, z: number) => number } | null = null;
  #dotGround(): (x: number, z: number) => number {
    const ground = this.groundHeightAt, water = this.waterSurfaceAt;
    if (this.#dotSampler?.ground !== ground || this.#dotSampler.water !== water) {
      this.#dotSampler = { ground, water, at: water ? (x, z) => Math.max(ground(x, z), water(x, z) ?? -Infinity) : ground };
    }
    return this.#dotSampler.at;
  }

  readonly #templates = new Map<string, Promise<THREE.Group>>();
  readonly #rigs = new Map<string, Rig>();
  /** Seconds of drawn time, for each animal's own look-up rhythm while it feeds or drinks. */
  #clockSeconds = 0;
  /** Ids whose model is being loaded. Without this, sync() would start a fresh load every frame. */
  readonly #pending = new Set<string>();
  readonly #ready = new Map<string, { animal: AnimalState; template: THREE.Group; variantKey: string }>();
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
  readonly #limbs = new CrownLimbs();

  /** The animal behind a dot a click landed on. */
  dotIdAt(index: number): string | undefined {
    return this.#dotLayer.idAt(index);
  }

  isDots(object: THREE.Object3D): boolean {
    return object === this.#dots;
  }

  /** Soft patches where standing animals meet the floor (contactShadows.ts). */
  readonly #contact = new ContactShadows();
  readonly #ripple = new DrinkingRipple();
  #watched: string | null = null;
  readonly #spots: ContactSpot[] = [];
  readonly #shadowFocus = new THREE.Vector2();
  readonly #soleWorld = new THREE.Vector3();

  constructor() {
    this.#dotLayer = new AnimalDots(AnimalLayer.MAX_DOTS); this.#dots = this.#dotLayer.mesh;
    this.root.add(this.#dots, this.#limbs.mesh, this.#contact.mesh);
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

  readonly #warmed = new Set<string>();

  /**
   * Loads each species' model ahead of need, compiles its shaders and uploads its textures, one
   * species at a time with a pause between, so an animal walking into view (or chosen from the
   * list) does not stall a frame the first time its kind is drawn. Costs memory, not frames.
   */
  async prewarm(animals: Iterable<AnimalState>, renderer: THREE.WebGLRenderer, camera: THREE.Camera, lit: THREE.Scene): Promise<number> {
    const representatives = new Map<string, AnimalState>();
    for (const animal of animals) {
      const key = variantKey(animal, false);
      if (!representatives.has(key) && !this.#warmed.has(key)) representatives.set(key, animal);
    }
    let warmed = 0;
    for (const [key, animal] of representatives) {
      try {
        const template = await this.#template(animal);
        const visual = cloneSkeleton(template), stage = new THREE.Scene(), textures = new Set<THREE.Texture>(), owned: THREE.Material[] = [];
        visual.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const own = (source: THREE.Material): THREE.Material => {
            const material = source.clone(); applyFurLook(material); owned.push(material);
            for (const value of Object.values(material)) if ((value as THREE.Texture | null)?.isTexture) textures.add(value as THREE.Texture);
            return material;
          };
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
        });
        stabilizeSkinning(visual); // the same shader the drawn rig gets
        stage.add(visual);
        await renderer.compileAsync(stage, camera, lit);
        for (const texture of textures) renderer.initTexture(texture);
        for (const material of owned) material.dispose();
        visual.traverse((o) => { (o as THREE.Mesh).customDepthMaterial?.dispose(); });
        this.#warmed.add(key); warmed++;
      } catch { /* that species loads when it is first needed instead */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return warmed;
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
          applyFurLook(material);
          return material;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
      }
    });
    // The template's material is cloned for each animal above. Shader hooks do not
    // survive Material.clone(), so grade the owned copy rather than the template.
    if (visualForAnimal(animal).model?.file?.startsWith('/assets/animals/AsianElephant'))
      elephantSurface(visual, false);
    // Far from the world's origin a skinned body is drawn from mesh-relative bones, so it does not shimmer (stableSkinning.ts).
    stabilizeSkinning(visual);

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

    const height = visualFor(animal.speciesId).heightM;
    const bodyLengthM = new THREE.Box3().setFromObject(visual).getSize(new THREE.Vector3()).z;
    const rig: Rig = { variantKey: key, speciesId: animal.speciesId, group, mixer, actions, clipNames: clips.map((c) => c.name), playing: null,
      visual, footY: visual.position.y, restRotationZ: visual.rotation.z, bodyLengthM, soles: standingSoles(visual), climbRest: null,
      needsCorpseGrounding: false, gait: new GaitClock(), hipM: hipHeightM(height * characterScale(animal), visualFor(animal.speciesId).hipFraction), swimming: false, seed: idSeed(animal.id), looksUp: animal.speciesId !== 'tiger' && animal.speciesId !== 'leopard',
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
    this.#watched = followedId;
    this.#shadowFocus.set(focus.x, focus.z);
    const positions = new Map<string, RenderPosition>();
    for (const animal of animals.values()) {
      // A diver under water is not drawn (Congo 1B): nothing of it shows until it surfaces.
      if (underWater(animal)) continue;
      const pose = recorded.get(animal.id);
      if (pose) {
        this.tracker.placeRecorded(animal.id, pose.position, nowMs);
        positions.set(animal.id, pose.position);
        continue;
      }
      this.tracker.update(animal.id, animal.patchId, nowMs, animal.position, animal.altitudeM);
      positions.set(animal.id, this.tracker.positionAt(animal.id, nowMs));
    }
    // A troop resting up one tree, and the birds perched in it, are recorded at the tree's one point: spread them through the crown.
    const aloft: PerchSubject[] = [];
    for (const [id, p] of positions) {
      const animal = animals.get(id)!;
      if (!recorded.has(id) && inCrown({ arboreal: arboreal(animal.speciesId), flies: flies(animal.speciesId) }, animal.locomotionMode, p.altitudeM)) {
        aloft.push({ id, x: p.x, z: p.z, altitudeM: p.altitudeM!, moving: p.moving });
      }
    }
    const perched = spreadInCrowns(aloft);
    for (const [id, place] of perched) positions.set(id, { ...positions.get(id)!, x: place.x, z: place.z, altitudeM: place.altitudeM });
    const budget = RENDER_BUDGETS[this.quality];
    const visible = chooseVisible(positions, focus, followedId, { max: budget.animalModels, radiusM: budget.animalRadius });
    const partner = followedId === null ? undefined : recorded.get(followedId)?.partnerId;
    if (partner && positions.has(partner)) visible.add(partner);
    this.#wanted = visible;
    this.#airborne = new Set([...visible].filter((id) => airborne(animals.get(id)!, positions.get(id)!.altitudeM,
      recorded.get(id)?.flightVisualPhase !== undefined)));
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
        const flightPhase = flies(animal.speciesId) ? pose.flightVisualPhase ?? null : null;
        const climbPhase = arboreal(animal.speciesId) ? pose.climbVisualPhase ?? null : null;
        const unknownAirborne = pose.kind === 'movement' && (position.altitudeM ?? 0) > 0
          && (flies(animal.speciesId) && flightPhase === null
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
    }

    this.#drawLimbs(visible, perched, positions);

    // Keep pending actors selectable as dots until their placed model is actually available.
    this.#dotLayer.sync(animals, positions, new Set([...visible].filter((id) => this.#rigs.has(id))), this.#dotGround());

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
    this.#watched = subjects[0]?.animal.id ?? null;
    if (subjects[0]) this.#shadowFocus.set(subjects[0].position.x, subjects[0].position.z);
    this.#limbs.begin(); this.#limbs.end();
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
    // Hunters drinking with their prey get the far shore (shoreSides).
    const drinkers: Array<{ id: string; x: number; z: number; hunter: boolean; seed: number }> = [];
    for (const id of visible) {
      const animal = animals.get(id), position = positions.get(id);
      if (!animal || !position || (recorded.get(id)?.animal ?? animal).state !== 'drinking') continue;
      drinkers.push({ id, x: position.x, z: position.z, hunter: HUNTERS.has(animal.speciesId), seed: idSeed(id) });
    }
    const sides = drinkers.length > 1 ? shoreSides(drinkers, this.pools) : new Map<string, number>();
    for (const id of visible) {
      const animal = animals.get(id), position = positions.get(id);
      if (!animal || !position || (position.altitudeM ?? 0) > 0 || flies(animal.speciesId)) continue;
      const pose = recorded.get(id);
      if (arboreal(animal.speciesId) && (animal.locomotionMode === 'climb' || pose?.climbVisualPhase !== undefined)) continue;
      const radius = visualFor(animal.speciesId).heightM * 0.5 * characterScale(animal);
      const shown = pose?.animal ?? animal;
      const ashore = onShore(position, this.pools, radius, shown.state === 'drinking', idSeed(id), sides.get(id));
      if (ashore !== position) positions.set(id, ashore);
      // A carcass lies where it fell; scavengers gather round it rather than nudging it.
      if (shown.state === 'dead') { fixed.push({ x: ashore.x, z: ashore.z, radius: radius * 0.8 }); continue; }
      bodies.push({ id, x: ashore.x, z: ashore.z, heading: ashore.heading, radius,
        ...(pose?.partnerId ? { partnerId: pose.partnerId } : {}), ...(HUNTERS.has(animal.speciesId) ? { hunter: true } : {}) });
    }
    if (bodies.length === 0) return;
    const sizes = new Map(bodies.map((b) => [b.id, b.radius]));
    for (const [id, clear] of separateBodies(bodies, fixed, this.avoid)) {
      const position = positions.get(id)!;
      if (clear.x === position.x && clear.z === position.z) continue;
      // Making room for a neighbour must not step an animal back onto the water.
      const shown = recorded.get(id)?.animal ?? animals.get(id)!;
      positions.set(id, onShore({ ...position, ...clear }, this.pools, sizes.get(id)!, shown.state === 'drinking', idSeed(id), sides.get(id)));
    }
  }

  #poseAt(rig: Rig, state: string, seconds: number, flightPhase: FlightVisualPhase | null = null,
    unknownAirborne = false, climbPhase: ClimbVisualPhase | null = null, act?: number, actWeight = 1): void {
    const grounded = flightPhase === null && climbPhase === null && !unknownAirborne;
    if (grounded) state = stateAtSpeed(state, rig.gait);
    const clip = swimmingClip(rig.swimming, state, rig.clipNames)
      ?? (grounded ? clipForGait(state, rig.gait.gait, rig.clipNames) : null)
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
        ? rig.gait.advance(strideRate(source, cyclesOf(source), rig.gait.speedMs, rig.hipM, strideCeiling(rig.clipNames)), source.duration)
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
    this.#ripple.mesh.visible = false;
    const rig = this.#watched ? this.#rigs.get(this.#watched) : null;
    if (rig?.speciesId === 'forest_elephant' && rig.group.visible) {
      const drink = rig.actions.get('Drinking');
      if (drink?.isScheduled() && drink.getEffectiveWeight() > 0.85) {
        const body = rig.visual.getObjectByName('Body') as THREE.SkinnedMesh | undefined;
        if (body?.isSkinnedMesh) this.#ripple.update(body, drink.time / drink.getClip().duration, this.pools, this.groundHeightAt);
      }
    }
    const ring = this.#ripple.mesh;
    if (ring.visible && !ring.parent) this.root.add(ring);
    else if (!ring.visible && ring.parent) ring.removeFromParent();
    this.#layContactShadows();
  }

  /** One floor patch under each drawn animal standing on the ground: not aloft, climbing or swimming. */
  #layContactShadows(): void {
    const spots = this.#spots; spots.length = 0;
    for (const rig of this.#rigs.values()) {
      if (!rig || !rig.group.visible || rig.group.parent === null || rig.climbRest !== null || rig.swimming) continue;
      const { x, y, z } = rig.group.position;
      const ground = this.groundHeightAt(x, z);
      if (y - ground > 0.3) continue;
      const lengthM = rig.bodyLengthM * rig.group.scale.y, heading = rig.group.rotation.y;
      const near = rig.group.name === this.#watched ||
        (x - this.#shadowFocus.x) ** 2 + (z - this.#shadowFocus.y) ** 2 < 16 ** 2;
      const body: ContactSpot = { x, y: ground, z, lengthM, heading };
      spots.push(body);
      if (!near) continue;
      const step = Math.max(0.12, lengthM * 0.2);
      body.slopeX = (this.groundHeightAt(x + step, z) - this.groundHeightAt(x - step, z)) / (2 * step);
      body.slopeZ = (this.groundHeightAt(x, z + step) - this.groundHeightAt(x, z - step)) / (2 * step);
      for (const sole of rig.soles) {
        const foot = sole.bone.localToWorld(this.#soleWorld.copy(sole.point));
        const floor = this.groundHeightAt(foot.x, foot.z);
        const contact = 1 - THREE.MathUtils.smoothstep(foot.y - floor, 0.015, Math.max(0.04, lengthM * 0.07));
        if (contact <= 0) continue;
        const width = Math.max(0.025, lengthM * 0.12) * contact;
        spots.push({ x: foot.x, z: foot.z, y: floor, heading, widthM: width,
          lengthM: width * 1.35, slopeX: body.slopeX, slopeZ: body.slopeZ });
      }
    }
    this.#contact.update(spots);
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

  /** The limb each drawn climber resting up a crown sits on. */
  #drawLimbs(visible: ReadonlySet<string>, perched: ReadonlyMap<string, CrownPlace>, positions: ReadonlyMap<string, RenderPosition>): void {
    this.#limbs.begin();
    for (const [id, place] of perched) {
      if (!visible.has(id) || !this.#rigs.has(id)) continue;
      this.#limbs.add(place.trunkX, place.trunkZ, place.x, renderBaseY(positions.get(id)!, this.groundHeightAt), place.z);
    }
    this.#limbs.end();
  }

  #place(rig: Rig, position: RenderPosition): void {
    if (rig.group.parent === null) this.root.add(rig.group);
    rig.group.visible = true;
    const base = renderBaseY(position, this.groundHeightAt);
    const swim = (position.altitudeM ?? 0) === 0 && this.waterSurfaceAt
      ? swimBaseY(base, this.waterSurfaceAt(position.x, position.z), rig.hipM) : { y: base, swimming: false };
    rig.swimming = swim.swimming;
    rig.group.position.set(position.x, swim.y, position.z);
    const current = rig.group.rotation.y;
    const diff = ((position.heading - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    rig.group.rotation.y = current + diff * 0.1;
    // A bird on the wing banks into its turns, wings tipped toward the inside (bankAngle).
    const bank = this.#airborne.has(rig.group.name) ? bankAngle(diff) : 0;
    rig.group.rotation.z += (bank - rig.group.rotation.z) * 0.08;
  }

  #animate(rig: Rig, state: string, climbPhase: ClimbVisualPhase | null = null,
    unknownAirborne = false): void {
    if (rig.mixer === null) return;
    const grounded = climbPhase === null && !unknownAirborne;
    if (grounded) state = stateAtSpeed(state, rig.gait);
    if (grounded && rig.looksUp && vigilance(state, this.#clockSeconds, rig.seed) > 0.5) state = 'standing';
    let wanted = swimmingClip(rig.swimming, state, rig.clipNames)
      ?? (grounded ? clipForGait(state, rig.gait.gait, rig.clipNames) : null)
      ?? clipForObservedMotion(state, rig.clipNames, null, unknownAirborne, climbPhase);
    // A fleeing duiker bounds: every few seconds a leap breaks its gallop (leapingClip).
    const leap = wanted === null ? null : leapingClip(state, wanted, rig.clipNames, rig.speciesId, this.#clockSeconds, rig.seed,
      rig.actions.get('Gallop_Jump')?.getClip().duration ?? 0);
    if (leap !== null) wanted = leap;
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
      // A swimmer's legs paddle slower than they would stride on land at its speed.
      ? strideRate(source, cyclesOf(source), rig.gait.speedMs, rig.hipM, strideCeiling(rig.clipNames)) * (rig.swimming ? 0.6 : 1) : 1;
    // Eased, so a change of pace is not a visible jolt in the legs.
    action.timeScale += (wanted - action.timeScale) * 0.15;
  }

  #appearance(rig: Rig, animal: AnimalState): void {
    const key = `${animal.state}|${animal.sizeRatio ?? ''}|${animal.coatVariant ?? ''}|${animal.decayStage ?? ''}`;
    if (rig.appearanceKey === key) return;
    rig.appearanceKey = key;
    rig.group.scale.setScalar(characterScale(animal));
    rig.hipM = hipHeightM(visualFor(animal.speciesId).heightM * characterScale(animal), visualFor(animal.speciesId).hipFraction);
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
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) { (o as THREE.SkinnedMesh).skeleton.dispose(); (o as THREE.Mesh).customDepthMaterial?.dispose(); }
    });
    this.root.remove(rig.group);
    this.#rigs.delete(id);
  }
}

/**
 * A flier is drawn in flight (wings spread) while a recorded flight plays or it is above the
 * ground, but not when it is perched on a branch (mode climb): there it stands.
 */
export function airborne(animal: { speciesId: string; locomotionMode?: string | undefined }, altitudeM: number | undefined, flying: boolean): boolean {
  if (!flies(animal.speciesId)) return false;
  if (flying) return true;
  return (altitudeM ?? 0) > 0.5 && animal.locomotionMode !== 'climb';
}

/** Congo 1B: an animal under water (a diving chevrotain) is out of sight. */
export function underWater(animal: { locomotionMode?: string | undefined }): boolean {
  return animal.locomotionMode === 'submerged';
}
