import * as THREE from 'three';
import { timeoutSignal } from './abortSignals.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { Person } from '@vana/shared';
import type { RenderTier } from './renderQuality.js';
import type { HumanPlaybackPose } from './communityPlayback.js';

export type HumanModel = 'female' | 'male';
export interface HumanTemplate { scene: THREE.Group; animations: THREE.AnimationClip[] }
export type HumanLoader = (model: HumanModel) => Promise<HumanTemplate>;
type SavedPerson = Pick<Person, 'id' | 'name' | 'appearanceSeed' | 'alive' | 'position' | 'massKg' | 'ageDays'> & {
  task: { kind: NonNullable<Person['task']>['kind']; phase: 'travel' | 'work' } | null;
  moving?: boolean; animationSeconds?: number;
};
interface Rig {
  root: THREE.Group; visual: THREE.Object3D; mixer: THREE.AnimationMixer;
  model: HumanModel; appearanceSeed: number; materials: THREE.Material[]; skeletons: Set<THREE.Skeleton>;
  clip: string | null; action: THREE.AnimationAction | null; lying: boolean;
  taskProps: Record<'fish' | 'hunt' | 'build', THREE.Group>;
}
export function humanAppearance(seed: number): { model: HumanModel; scale: number; cloth: number; hair: number } {
  const n = seed >>> 0;
  // Presentation-only body templates, not an inferred biological sex or cultural identity.
  return { model: n % 2 ? 'male' : 'female', scale: .94 + ((n >>> 3) % 13) / 100,
    cloth: [0xb2bca5, 0xb9a17c, 0x929eaf, 0xb69b97][(n >>> 8) % 4]!, hair: [0x30291f, 0x514335, 0x786857][(n >>> 11) % 3]! };
}
/** Illustrative size only. The same generic game rigs represent all ages. */
export function humanAgeScale(ageDays: number): number {
  if (ageDays < 6 * 360) return .42 + .28 * Math.max(0, ageDays) / (6 * 360);
  if (ageDays < 18 * 360) return .7 + .3 * (ageDays - 6 * 360) / (12 * 360);
  return 1;
}
/**
 * A child's head is far larger for its body than an adult's (about a quarter of body length at
 * birth, an eighth in adults). The adult models are scaled down for children; their head bone is
 * scaled up, from 1.4x at birth to 1x at eighteen, so a child does not read as a small adult.
 */
export function childHeadScale(ageDays: number): number {
  const years = Math.max(0, ageDays) / 360;
  return years >= 18 ? 1 : 1 + 0.4 * (1 - years / 18) ** 1.5;
}
export function humanPose(p: Pick<SavedPerson, 'alive' | 'task' | 'moving'>): { clip: string; lying: boolean } {
  if (!p.alive || (p.task?.phase === 'work' && p.task.kind === 'sleep')) return { clip: 'Death01', lying: true };
  if (p.task?.phase === 'travel') return { clip: p.moving === false ? 'Idle_Loop' : 'Walk_Loop', lying: false };
  const kind = p.task?.kind;
  const clip = kind === 'build' || kind === 'repair' ? 'Fixing_Kneeling'
    : kind?.startsWith('gather_') || kind === 'deliver' ? 'PickUp_Table'
      : kind && ['eat', 'drink', 'collect_water', 'fish', 'hunt', 'cook', 'care_child'].includes(kind) ? 'Interact' : 'Idle_Loop';
  return { clip, lying: false };
}
export function tintHumanMaterial(material: THREE.Material, seed: number): void {
  const appearance = humanAppearance(seed);
  if (material instanceof THREE.MeshStandardMaterial) {
    if (/Peasant/.test(material.name)) material.color.multiply(new THREE.Color(appearance.cloth));
    if (/Hair/.test(material.name)) material.color.multiply(new THREE.Color(appearance.hair));
  }
}
export function tintHumanScene(root: THREE.Object3D, seed: number): void {
  const seen = new Set<THREE.Material>();
  root.traverse(o => {
    const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!seen.has(material)) { tintHumanMaterial(material, seed); seen.add(material); }
    }
  });
}

export const loadHuman: HumanLoader = async model => {
  const response = await fetch(`/assets/humans-v1/human-${model}.glb`, { signal: timeoutSignal(20_000) });
  if (!response.ok) throw new Error(`Human model HTTP ${response.status}`);
  const data = await response.arrayBuffer();
  if (data.byteLength > 8_000_000) throw new Error('Human asset exceeds download budget');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().parseAsync(data, '');
  return { scene: gltf.scene, animations: gltf.animations };
};
function disposeTemplate(template: HumanTemplate): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>(), skeletons = new Set<THREE.Skeleton>();
  template.scene.traverse(o => {
    const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
    geometries.add(mesh.geometry); for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((o as THREE.SkinnedMesh).skeleton);
  });
  for (const material of materials) for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
  for (const texture of textures) { texture.dispose(); (texture.source.data as { close?: () => void } | null)?.close?.(); }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}

/** Bounded, lazy, checkpoint-only human rendering. Never extrapolates a planned journey. */
/**
 * People given the same spot (a household resting at home all share the house's position)
 * are drawn in a small ring round it, in id order, instead of inside one another. Anyone
 * standing on their own is left exactly where recorded. Presentation only.
 */
export function spreadCrowded<T extends { id: string; position: { x: number; z: number; heading: number } }>(people: readonly T[]): T[] {
  const TOUCH_M = 0.6, RING_M = 0.8;
  const groups: T[][] = [];
  for (const p of [...people].sort((a, b) => a.id.localeCompare(b.id))) {
    const group = groups.find(g => Math.hypot(g[0]!.position.x - p.position.x, g[0]!.position.z - p.position.z) < TOUCH_M);
    if (group) group.push(p); else groups.push([p]);
  }
  const moved = new Map<string, T>();
  for (const group of groups) {
    if (group.length < 2) continue;
    const { x, z } = group[0]!.position;
    group.forEach((p, i) => {
      const angle = i / group.length * Math.PI * 2;
      moved.set(p.id, { ...p, position: { ...p.position, x: x + Math.sin(angle) * RING_M, z: z + Math.cos(angle) * RING_M } });
    });
  }
  return people.map(p => moved.get(p.id) ?? p);
}

export class HumanLayer {
  readonly root = new THREE.Group();
  readonly #geometry = new THREE.BufferGeometry();
  readonly #material = new THREE.PointsMaterial({ color: '#efdb98', size: 10, sizeAttenuation: false });
  readonly #markers = new THREE.Points(this.#geometry, this.#material);
  readonly #childGeometry = new THREE.BufferGeometry();
  readonly #childMaterial = new THREE.PointsMaterial({ color: '#b7e1ac', size: 7, sizeAttenuation: false });
  readonly #childMarkers = new THREE.Points(this.#childGeometry, this.#childMaterial);
  readonly #toolShaft = new THREE.CylinderGeometry(1, 1, 1, 6);
  readonly #toolPoint = new THREE.ConeGeometry(1, 1, 6);
  readonly #toolHead = new THREE.BoxGeometry(1, 1, 1);
  readonly #toolWood = new THREE.MeshStandardMaterial({ color: '#795939', roughness: 1 });
  readonly #toolLine = new THREE.MeshStandardMaterial({ color: '#d6d3ba', roughness: 1 });
  readonly #toolStone = new THREE.MeshStandardMaterial({ color: '#77796f', roughness: 1 });
  readonly #templates = new Map<HumanModel, { status: 'loading' | 'ready' | 'failed'; template?: HumanTemplate }>();
  readonly #rigs = new Map<string, Rig>();
  #people: SavedPerson[] = [];
  #ground: (x: number, z: number) => number = () => 0;
  #disposed = false;
  nearby = false;
  /** Where the people drawn in 3D stand, for animals to keep clear of. */
  placed: Array<{ x: number; z: number; radius: number }> = [];
  constructor(private readonly load: HumanLoader = loadHuman) {
    this.root.name = 'checkpoint-humans'; this.#markers.name = 'saved-person-location-markers'; this.#childMarkers.name = 'saved-child-location-markers';
    this.root.add(this.#markers, this.#childMarkers);
    this.#geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3)); this.#geometry.setDrawRange(0, 0);
    this.#childGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)); this.#childGeometry.setDrawRange(0, 0);
  }
  get status(): 'markers' | 'loading' | 'ready' | 'failed' {
    const entries = [...this.#templates.values()];
    return entries.some(e => e.status === 'failed') ? 'failed' : entries.some(e => e.status === 'loading') ? 'loading'
      : entries.length ? 'ready' : 'markers';
  }
  sync(people: readonly Person[], ground: (x: number, z: number) => number): void {
    if (this.#disposed) return;
    this.#people = people.filter(p => p.massKg > 0).map(p => ({ id: p.id, name: p.name, appearanceSeed: p.appearanceSeed, alive: p.alive, ageDays: p.ageDays,
      position: { ...p.position }, task: p.task ? { kind: p.task.kind, phase: p.task.phase } : null, massKg: p.massKg, moving: false }));
    this.#ground = ground;
    const wanted = new Set(this.#people.map(p => p.id));
    for (const [id, rig] of this.#rigs) if (!wanted.has(id)) { this.#release(rig); this.#rigs.delete(id); }
    this.#drawMarkers(new Set());
  }
  positionOf(id: string, poses: ReadonlyMap<string, HumanPlaybackPose> = new Map()):
    { x: number; y: number; z: number; heading: number; moving: boolean; name: string; alive: boolean; recorded: boolean; scale: number } | null {
    const saved = this.#people.find(p => p.id === id); if (!saved || this.#disposed) return null;
    const pose = poses.get(id);
    // Where the person is drawn: the same spreading as update(), so a followed person is centred.
    const p = spreadCrowded(this.#people.map(q => { const qp = poses.get(q.id); return qp ? { ...q, ...qp } : q; }))
      .find(q => q.id === id)!;
    return { ...p.position, y: this.#ground(p.position.x, p.position.z) + (humanPose(p).lying ? .09 : .03),
      moving: p.moving ?? false, name: saved.name, alive: p.alive, recorded: !!pose, scale: humanAgeScale(saved.ageDays) };
  }
  #drawMarkers(detailed: Set<string>, people = this.#people): void {
    for (const [geometry, child] of [[this.#geometry, false], [this.#childGeometry, true]] as const) {
      if (geometry.getAttribute('position').count < people.length)
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(people.length * 3), 3));
      const positions = geometry.getAttribute('position') as THREE.BufferAttribute; let n = 0;
      for (const p of people) if (!detailed.has(p.id) && (p.ageDays < 6 * 360) === child)
        positions.setXYZ(n++, p.position.x, this.#ground(p.position.x, p.position.z) + (p.alive ? 1.65 * humanAgeScale(p.ageDays) : .15), p.position.z);
      positions.needsUpdate = true; geometry.setDrawRange(0, n);
      if (n) geometry.computeBoundingSphere();
    }
  }
  #request(model: HumanModel): void {
    if (this.#templates.has(model)) return;
    this.#templates.set(model, { status: 'loading' });
    void Promise.resolve().then(() => this.load(model)).then(template => {
      if (this.#disposed) { disposeTemplate(template); return; }
      this.#templates.set(model, { status: 'ready', template });
    }).catch(() => { if (!this.#disposed) this.#templates.set(model, { status: 'failed' }); });
  }
  #segment(group: THREE.Group, name: string, from: THREE.Vector3, to: THREE.Vector3,
    radius: number, material: THREE.Material): void {
    const mesh = new THREE.Mesh(this.#toolShaft, material);
    mesh.name = name;
    mesh.position.copy(from).add(to).multiplyScalar(.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    mesh.scale.set(radius, from.distanceTo(to), radius);
    mesh.castShadow = true;
    group.add(mesh);
  }
  #createTaskProps(root: THREE.Group): Rig['taskProps'] {
    const fish = new THREE.Group(), hunt = new THREE.Group(), build = new THREE.Group();
    fish.name = 'task-prop-fish'; hunt.name = 'task-prop-hunt'; build.name = 'task-prop-build';
    // Tools are illustrative work cues. They contain no prey, catch, resource, or finished structure.
    this.#segment(fish, 'fishing-rod', new THREE.Vector3(.38, 1.0, .08), new THREE.Vector3(.57, 2.06, -1.12), .024, this.#toolWood);
    this.#segment(fish, 'fishing-line', new THREE.Vector3(.57, 2.06, -1.12), new THREE.Vector3(.57, .28, -1.42), .004, this.#toolLine);
    this.#segment(hunt, 'hunting-spear-shaft', new THREE.Vector3(.43, .96, .27), new THREE.Vector3(.43, 1.44, -1.28), .026, this.#toolWood);
    const spearPoint = new THREE.Mesh(this.#toolPoint, this.#toolStone);
    spearPoint.name = 'hunting-spear-point'; spearPoint.position.set(.43, 1.5, -1.49);
    spearPoint.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, .3, -1).normalize());
    spearPoint.scale.set(.065, .38, .065); spearPoint.castShadow = true; hunt.add(spearPoint);
    this.#segment(build, 'construction-mallet-handle', new THREE.Vector3(.4, .41, -.2), new THREE.Vector3(.4, 1.29, -.48), .029, this.#toolWood);
    const head = new THREE.Mesh(this.#toolHead, this.#toolStone);
    head.name = 'construction-mallet-head'; head.position.set(.4, 1.31, -.49);
    head.scale.set(.3, .13, .17); head.castShadow = true; build.add(head);
    root.add(fish, hunt, build);
    return { fish, hunt, build };
  }
  #syncTaskProps(rig: Rig, p: SavedPerson): void {
    const kind = p.alive && p.task?.phase === 'work' ? p.task.kind : null;
    rig.taskProps.fish.visible = kind === 'fish';
    rig.taskProps.hunt.visible = kind === 'hunt';
    rig.taskProps.build.visible = kind === 'build' || kind === 'repair';
    const scale = humanAgeScale(p.ageDays);
    for (const prop of Object.values(rig.taskProps)) prop.scale.setScalar(scale);
  }
  #create(p: SavedPerson, model: HumanModel, template: HumanTemplate): Rig {
    const visual = cloneSkeleton(template.scene), root = new THREE.Group(), materials: THREE.Material[] = [], skeletons = new Set<THREE.Skeleton>();
    const appearance = humanAppearance(p.appearanceSeed);
    visual.scale.setScalar(appearance.scale * humanAgeScale(p.ageDays));
    visual.traverse(o => {
      const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
      const tint = (source: THREE.Material) => {
        const material = source.clone(); materials.push(material);
        tintHumanMaterial(material, p.appearanceSeed);
        return material;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tint) : tint(mesh.material);
      mesh.castShadow = true; mesh.receiveShadow = true;
      // Animate within a tiny bounded population; stale bind-pose spheres must not cull a lying body.
      mesh.frustumCulled = false;
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((o as THREE.SkinnedMesh).skeleton);
    });
    root.name = p.id; root.add(visual); this.root.add(root);
    const taskProps = this.#createTaskProps(root);
    return { root, visual, materials, skeletons, model, appearanceSeed: p.appearanceSeed, mixer: new THREE.AnimationMixer(visual), clip: null, action: null, lying: false, taskProps };
  }
  update(dt: number, camera: THREE.Vector3, tier: RenderTier, reducedMotion: boolean, enabled = true,
    poses: ReadonlyMap<string, HumanPlaybackPose> = new Map(), preferredId: string | null = null,
    historicOnlyId: string | null = null, staticRecordedPose = false): void {
    if (this.#disposed) return;
    const radius = tier === 'smooth' ? 65 : 120, limit = tier === 'smooth' ? 2 : 4;
    const distance = (p: SavedPerson) => Math.hypot(p.position.x - camera.x, this.#ground(p.position.x, p.position.z) - camera.y, p.position.z - camera.z);
    // Spread over the whole household, then pick, so positionOf() agrees in historic view too.
    const recordedPeople = (!reducedMotion || staticRecordedPose) && enabled ? this.#people.map(p => {
      const pose = poses.get(p.id); return pose ? { ...p, ...pose } : p;
    }) : this.#people;
    const pick = <T extends { id: string }>(list: T[]) => historicOnlyId === null ? list : list.filter(p => p.id === historicOnlyId);
    const people = pick(spreadCrowded(recordedPeople));
    // Distant location dots stay exactly on the recorded positions; only 3D figures need room.
    const markers = pick(recordedPeople);
    const nearest = enabled ? people.filter(p => distance(p) <= radius).sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId)
      || distance(a) - distance(b) || a.id.localeCompare(b.id)).slice(0, limit) : [];
    this.nearby = nearest.length > 0;
    this.placed = nearest.map(p => ({ x: p.position.x, z: p.position.z, radius: 0.35 * humanAgeScale(p.ageDays) }));
    const wanted = new Set(nearest.map(p => p.id)), detailed = new Set<string>();
    for (const [id, rig] of this.#rigs) if (!wanted.has(id)) { this.#release(rig); this.#rigs.delete(id); }
    for (const p of nearest) {
      const model = humanAppearance(p.appearanceSeed).model;
      this.#request(model); const template = this.#templates.get(model)?.template;
      if (!template) continue;
      let rig = this.#rigs.get(p.id);
      const pose = humanPose(p), clip = template.animations.find(a => a.name === pose.clip);
      if (rig && (rig.model !== model || rig.appearanceSeed !== p.appearanceSeed || !clip)) { this.#release(rig); this.#rigs.delete(p.id); rig = undefined; }
      if (!clip) continue;
      if (!rig) { rig = this.#create(p, model, template); this.#rigs.set(p.id, rig); }
      rig.visual.scale.setScalar(humanAppearance(p.appearanceSeed).scale * humanAgeScale(p.ageDays));
      this.#syncTaskProps(rig, p);
      if (rig.clip !== pose.clip || rig.lying !== pose.lying) {
        rig.mixer.stopAllAction(); rig.action = rig.mixer.clipAction(clip); rig.action.reset().play();
        rig.clip = pose.clip; rig.lying = pose.lying;
      }
      if (pose.lying) { rig.action!.time = Math.max(0, clip.duration - 1e-4); rig.mixer.update(0); }
      else if (reducedMotion) { rig.action!.time = Math.min(.3, clip.duration / 2); rig.mixer.update(0); }
      else if (p.animationSeconds !== undefined) { rig.action!.time = p.animationSeconds % clip.duration; rig.mixer.update(0); }
      else rig.mixer.update(Number.isFinite(dt) ? Math.min(.1, Math.max(0, dt)) : 0);
      // After the clip: a child's larger head (the clips never scale bones, but this keeps it so).
      const head = rig.visual.getObjectByName('Head');
      if (head) head.scale.setScalar(childHeadScale(p.ageDays));
      // Small retarget sole/body clearance, not terrain IK or a new authoritative location.
      rig.root.position.set(p.position.x, this.#ground(p.position.x, p.position.z) + (pose.lying ? .09 : .03), p.position.z);
      rig.root.rotation.y = p.position.heading;
      detailed.add(p.id);
    }
    this.#drawMarkers(detailed, markers);
  }
  #release(rig: Rig): void {
    rig.mixer.stopAllAction(); rig.mixer.uncacheRoot(rig.visual); rig.root.removeFromParent();
    for (const skeleton of rig.skeletons) skeleton.dispose();
    for (const material of rig.materials) material.dispose(); // Geometry/textures belong to the shared template.
  }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true;
    for (const rig of this.#rigs.values()) this.#release(rig); this.#rigs.clear();
    for (const entry of this.#templates.values()) if (entry.template) disposeTemplate(entry.template);
    this.#templates.clear(); this.#geometry.dispose(); this.#material.dispose(); this.#childGeometry.dispose(); this.#childMaterial.dispose();
    this.#toolShaft.dispose(); this.#toolPoint.dispose(); this.#toolHead.dispose(); this.#toolWood.dispose(); this.#toolLine.dispose(); this.#toolStone.dispose();
    this.root.clear(); this.root.removeFromParent();
  }
}
