import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { clipForState } from './animation.js';
import { PositionTracker, type RenderPosition } from './space.js';
import type { AnimalState } from './protocol.js';
import { chooseVisible } from './lod.js';

/** Shoulder heights in metres, matching the species config on the server. */
const SPECIES_MODEL: Record<string, { file: string; heightM: number }> = {
  sambar: { file: '/assets/animals/Deer.gltf', heightM: 1.35 },
  tiger:  { file: '/assets/animals/Tiger.glb', heightM: 1.0 },
};
const FALLBACK = SPECIES_MODEL.sambar!;

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

  async #template(speciesId: string): Promise<THREE.Group> {
    const config = SPECIES_MODEL[speciesId] ?? FALLBACK;
    let pending = this.#templates.get(speciesId);
    if (pending === undefined) {
      pending = this.#loader.loadAsync(config.file).then((gltf) => {
        const root = gltf.scene;
        root.userData.clips = gltf.animations;
        const box = new THREE.Box3().setFromObject(root);
        const height = Math.max(box.max.y - box.min.y, 0.001);
        root.userData.scale = config.heightM / height;
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
    marker.scale.set(2.2, 2.2, 1);
    marker.position.y = 3.2;
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
