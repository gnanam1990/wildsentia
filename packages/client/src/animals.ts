import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { clipForState } from './animation.js';
import { PositionTracker, type RenderPosition } from './space.js';
import type { AnimalState } from './protocol.js';
import { chooseVisible } from './lod.js';
import { visualFor } from './species.js';

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

interface Rig {
  group: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  actions: Map<string, THREE.AnimationAction>;
  clipNames: string[];
  playing: string | null;
  marker: THREE.Sprite;
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
  /** Set once the terrain is known, so animals stand on the ground rather than at sea level. */
  groundHeightAt: (x: number, z: number) => number = () => 0;

  readonly #loader = new GLTFLoader();
  readonly #templates = new Map<string, Promise<THREE.Group>>();
  readonly #rigs = new Map<string, Rig>();
  /** Ids whose model is being loaded. Without this, sync() would start a fresh load every frame. */
  readonly #pending = new Set<string>();
  readonly #markerTexture = markerTexture();

  /**
   * Every animal too far away for a model is still shown: a dot in its species' colour, a
   * constant few pixels across, all in one draw call. Without it the forest looked empty past a
   * few hundred metres, and only whatever lived next to the camera — deer and boar — was seen.
   */
  readonly #dots: THREE.Points;
  readonly #dotPositions: Float32Array;
  readonly #dotColours: Float32Array;
  readonly #dotIds: string[] = [];
  static readonly MAX_DOTS = 8000;

  /** The animal behind a dot a click landed on. */
  dotIdAt(index: number): string | undefined {
    return this.#dotIds[index];
  }

  isDots(object: THREE.Object3D): boolean {
    return object === this.#dots;
  }

  constructor() {
    this.#dotPositions = new Float32Array(AnimalLayer.MAX_DOTS * 3);
    this.#dotColours = new Float32Array(AnimalLayer.MAX_DOTS * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.#dotPositions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.#dotColours, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    this.#dots = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: 5, sizeAttenuation: false, vertexColors: true, depthWrite: false,
    }));
    this.#dots.name = 'animal-dots';
    this.#dots.frustumCulled = false;
    this.root.add(this.#dots);
  }

  async #template(speciesId: string): Promise<THREE.Group> {
    const visual = visualFor(speciesId);
    let pending = this.#templates.get(speciesId);
    if (pending === undefined) {
      const loaded: Promise<{ root: THREE.Group; clips: THREE.AnimationClip[] }> = visual.model === null
        ? Promise.resolve({ root: standIn(visual.colour), clips: [] })
        : this.#loader.loadAsync(visual.model.file).then((gltf) => ({ root: gltf.scene, clips: gltf.animations }));
      pending = loaded.then(({ root, clips }) => {
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
        root.userData.scale = visual.heightM / height;
        root.userData.footOffset = box.min.y;
        return root;
      });
      this.#templates.set(speciesId, pending);
    }
    return pending;
  }

  async #ensureRig(animal: AnimalState): Promise<void> {
    if (this.#rigs.has(animal.id) || this.#pending.has(animal.id)) return;
    this.#pending.add(animal.id);

    let template: THREE.Group;
    try {
      template = await this.#template(animal.speciesId);
    } catch (error) {
      console.error(`could not load a model for ${animal.speciesId}`, error);
      this.#pending.delete(animal.id);
      return;
    }
    const visual = cloneSkeleton(template);
    const scale = template.userData.scale as number;
    visual.scale.setScalar(scale);
    visual.position.y = -(template.userData.footOffset as number) * scale;
    visual.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
    });

    const group = new THREE.Group();
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
    const size = Math.max(0.5, height * 0.8);
    marker.scale.set(size, size, 1);
    marker.position.y = height + size * 0.9;
    marker.visible = false;
    group.add(marker);

    const rig: Rig = { group, mixer, actions, clipNames: clips.map((c) => c.name), playing: null, marker };
    this.#pending.delete(animal.id);
    this.#rigs.set(animal.id, rig);
    this.root.add(group);
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
  ): void {
    const positions = new Map<string, RenderPosition>();
    for (const animal of animals.values()) {
      this.tracker.update(animal.id, animal.patchId, nowMs);
      positions.set(animal.id, this.tracker.positionAt(animal.id, nowMs));
    }
    const visible = chooseVisible(positions, focus, followedId);
    this.#fillDots(animals, positions, visible);

    for (const id of visible) {
      const animal = animals.get(id)!;
      void this.#ensureRig(animal);
      const rig = this.#rigs.get(id);
      if (!rig) continue;
      const position = positions.get(id)!;
      this.#place(rig, position);
      this.#animate(rig, position.moving ? 'travelling' : animal.state);
      rig.marker.visible = id === followedId;
    }

    this.tracker.forgetAllExcept(new Set(animals.keys()));
    for (const [id, rig] of [...this.#rigs]) {
      if (visible.has(id)) continue;
      this.root.remove(rig.group);
      this.#rigs.delete(id);
    }
  }

  /**
   * Shows one animal alone, at a position the replay computed from its recorded track. Every
   * other model is released while a life is replayed; they come back when live sync resumes.
   */
  syncReplay(animal: AnimalState, position: RenderPosition): void {
    this.#dots.geometry.setDrawRange(0, 0);
    void this.#ensureRig(animal);
    for (const [id, rig] of [...this.#rigs]) {
      if (id === animal.id) continue;
      this.root.remove(rig.group);
      this.#rigs.delete(id);
    }
    const rig = this.#rigs.get(animal.id);
    if (!rig) return;
    this.#place(rig, position);
    this.#animate(rig, position.moving ? 'travelling' : animal.state);
    rig.marker.visible = true;
  }

  #fillDots(
    animals: ReadonlyMap<string, AnimalState>,
    positions: ReadonlyMap<string, RenderPosition>,
    modelled: ReadonlySet<string>,
  ): void {
    const colour = new THREE.Color();
    let n = 0;
    this.#dotIds.length = 0;
    for (const [id, position] of positions) {
      if (modelled.has(id) || n >= AnimalLayer.MAX_DOTS) continue;
      this.#dotIds.push(id);
      const visual = visualFor(animals.get(id)!.speciesId);
      this.#dotPositions[n * 3] = position.x;
      this.#dotPositions[n * 3 + 1] = this.groundHeightAt(position.x, position.z) + visual.heightM;
      this.#dotPositions[n * 3 + 2] = position.z;
      colour.setHex(visual.colour);
      this.#dotColours[n * 3] = colour.r;
      this.#dotColours[n * 3 + 1] = colour.g;
      this.#dotColours[n * 3 + 2] = colour.b;
      n++;
    }
    const geometry = this.#dots.geometry;
    geometry.setDrawRange(0, n);
    geometry.attributes.position!.needsUpdate = true;
    geometry.attributes.color!.needsUpdate = true;
  }

  positionOf(id: string, nowMs: number): RenderPosition | null {
    return this.tracker.has(id) ? this.tracker.positionAt(id, nowMs) : null;
  }

  update(deltaSeconds: number): void {
    for (const rig of this.#rigs.values()) rig?.mixer?.update(deltaSeconds);
  }

  #place(rig: Rig, position: RenderPosition): void {
    rig.group.position.set(position.x, this.groundHeightAt(position.x, position.z), position.z);
    const current = rig.group.rotation.y;
    const diff = ((position.heading - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    rig.group.rotation.y = current + diff * 0.1;
  }

  #animate(rig: Rig, state: string): void {
    if (rig.mixer === null) return;
    const wanted = clipForState(state, rig.clipNames);
    // Null means this model has nothing suitable. Leave it on whatever it was playing rather
    // than showing a clip that contradicts the server's state.
    if (wanted === null || wanted === rig.playing) return;

    const next = rig.actions.get(wanted);
    if (next === undefined) return;

    const previous = rig.playing === null ? null : rig.actions.get(rig.playing) ?? null;
    next.reset().play();
    if (previous !== null) previous.crossFadeTo(next, 0.35, false);
    rig.playing = wanted;
  }
}
