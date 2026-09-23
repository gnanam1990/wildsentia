import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PATCH_METRES, patchCentre } from './space.js';
import type { HeightSampler, PatchView } from './terrain.js';

/**
 * Close-up nature from Quaternius' Stylized Nature MegaKit (CC0), scaled from the models' own
 * sizes to real ones: shola trees 14-20 m, riparian trees 16-22 m, grass knee high. Each kind is
 * drawn as instances, so the whole near forest costs a few dozen draw calls.
 */
export const NATURE_KINDS: Record<string, { file: string; scale: [number, number] }> = {
  CommonTree_1:       { file: 'CommonTree_1.glb', scale: [1.9, 2.7] },
  CommonTree_2:       { file: 'CommonTree_2.glb', scale: [1.9, 2.7] },
  CommonTree_3:       { file: 'CommonTree_3.glb', scale: [1.5, 2.1] },
  CommonTree_4:       { file: 'CommonTree_4.glb', scale: [1.6, 2.3] },
  TwistedTree_1:      { file: 'TwistedTree_1.glb', scale: [0.95, 1.3] },
  TwistedTree_3:      { file: 'TwistedTree_3.glb', scale: [0.95, 1.3] },
  DeadTree_2:         { file: 'DeadTree_2.glb', scale: [0.8, 1.1] },
  Bush_Common:        { file: 'Bush_Common.glb', scale: [0.7, 1.2] },
  Bush_Common_Flowers:{ file: 'Bush_Common_Flowers.glb', scale: [0.7, 1.1] },
  Fern_1:             { file: 'Fern_1.glb', scale: [0.3, 0.45] },
  Plant_1_Big:        { file: 'Plant_1_Big.glb', scale: [0.25, 0.4] },
  Plant_7_Big:        { file: 'Plant_7_Big.glb', scale: [0.4, 0.7] },
  Grass_Common_Tall:  { file: 'Grass_Common_Tall.glb', scale: [0.35, 0.55] },
  Grass_Common_Short: { file: 'Grass_Common_Short.glb', scale: [0.25, 0.4] },
  Grass_Wispy_Tall:   { file: 'Grass_Wispy_Tall.glb', scale: [0.45, 0.65] },
  Flower_3_Group:     { file: 'Flower_3_Group.glb', scale: [0.2, 0.3] },
  Flower_4_Group:     { file: 'Flower_4_Group.glb', scale: [0.2, 0.3] },
  Clover_1:           { file: 'Clover_1.glb', scale: [0.15, 0.25] },
  Rock_Medium_1:      { file: 'Rock_Medium_1.glb', scale: [0.4, 1.1] },
  Rock_Medium_2:      { file: 'Rock_Medium_2.glb', scale: [0.4, 1.1] },
  Rock_Medium_3:      { file: 'Rock_Medium_3.glb', scale: [0.4, 1.0] },
  Mushroom_Common:    { file: 'Mushroom_Common.glb', scale: [0.25, 0.4] },
};

type Driver = 'grass' | 'canopy' | 'fixed';

/** What grows in a 300 m patch of each habitat at full vigour, and what drives how much. */
const HABITAT_MIX: Record<string, Array<[kind: string, perPatch: number, driver: Driver]>> = {
  grassland: [
    ['Grass_Common_Tall', 180, 'grass'], ['Grass_Common_Short', 220, 'grass'],
    ['Grass_Wispy_Tall', 90, 'grass'], ['Clover_1', 40, 'grass'],
    ['Flower_3_Group', 18, 'grass'], ['Flower_4_Group', 12, 'grass'],
    ['Bush_Common', 10, 'fixed'], ['CommonTree_3', 2, 'fixed'],
  ],
  shola: [
    ['CommonTree_1', 10, 'canopy'], ['CommonTree_2', 10, 'canopy'], ['CommonTree_4', 8, 'canopy'],
    ['Fern_1', 60, 'fixed'], ['Bush_Common', 25, 'fixed'], ['Plant_1_Big', 30, 'fixed'],
    ['Mushroom_Common', 12, 'fixed'], ['Grass_Common_Short', 60, 'grass'],
  ],
  riparian: [
    ['TwistedTree_1', 3, 'canopy'], ['TwistedTree_3', 3, 'canopy'],
    ['Bush_Common_Flowers', 20, 'fixed'], ['Fern_1', 30, 'fixed'],
    ['Grass_Wispy_Tall', 140, 'grass'], ['Plant_7_Big', 30, 'fixed'],
  ],
  marsh: [
    ['Grass_Wispy_Tall', 260, 'grass'], ['Plant_7_Big', 50, 'fixed'], ['Clover_1', 40, 'grass'],
  ],
  rock: [
    ['Rock_Medium_1', 10, 'fixed'], ['Rock_Medium_2', 10, 'fixed'], ['Rock_Medium_3', 8, 'fixed'],
    ['DeadTree_2', 2, 'fixed'], ['Grass_Common_Short', 40, 'grass'],
  ],
  water: [],
};

export interface PlacedPlant { x: number; y: number; z: number; rotY: number; scale: number }

export interface PlanOptions {
  /** Multiplies how many of each kind grow; for a denser carpet close to the camera. */
  boost?: number;
  /** Plans only the kinds this accepts. */
  only?: (kind: string) => boolean;
  /** Varies placement so a second pass does not stack plants on the first. */
  salt?: number;
}

/**
 * Where every plant near the camera goes: the same answer for the same patch every time, so the
 * forest never reshuffles as the camera moves. Grass follows how much grass the simulation says
 * is standing, trees how much canopy it reports; nothing is placed beyond `radiusM` of the focus.
 */
export function planVegetation(
  patches: readonly PatchView[],
  focus: { x: number; z: number },
  radiusM: number,
  groundAt: HeightSampler,
  options: PlanOptions = {},
): Map<string, PlacedPlant[]> {
  const boost = options.boost ?? 1;
  const salt = options.salt ?? 0;
  const plan = new Map<string, PlacedPlant[]>();
  const reach = radiusM + PATCH_METRES;
  for (const patch of patches) {
    const centre = patchCentre(patch.id);
    if (Math.abs(centre.x - focus.x) > reach || Math.abs(centre.z - focus.z) > reach) continue;
    const grass = Math.min(1, Math.max(0.05, patch.grass / 6000));
    const canopy = Math.min(1.3, (patch.canopyCover ?? 0) / 0.7);
    const mix = HABITAT_MIX[patch.habitat] ?? [];
    mix.forEach(([kind, perPatch, driver], k) => {
      if (options.only !== undefined && !options.only(kind)) return;
      const count = Math.round(boost * perPatch * (driver === 'grass' ? grass : driver === 'canopy' ? canopy : 1));
      let seed = (patch.id * 73_856_093) ^ ((k + 1) * 19_349_663) ^ (salt * 83_492_791);
      const random = (): number => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 4_294_967_296;
      };
      const [lo, hi] = NATURE_KINDS[kind]!.scale;
      const list = plan.get(kind) ?? [];
      for (let i = 0; i < count; i++) {
        const x = centre.x + (random() - 0.5) * PATCH_METRES;
        const z = centre.z + (random() - 0.5) * PATCH_METRES;
        const rotY = random() * Math.PI * 2;
        const scale = lo + (hi - lo) * random();
        if (Math.hypot(x - focus.x, z - focus.z) > radiusM) continue;
        list.push({ x, y: groundAt(x, z), z, rotY, scale });
      }
      plan.set(kind, list);
    });
  }
  return plan;
}

/** Near-field detail radius, and how far the focus moves before the plan is rebuilt. */
export const NEAR_RADIUS_M = 450;
/** Within this, grass grows six times as thick: the carpet a close camera actually sees. */
const DENSE_RADIUS_M = 120;
const DENSE_BOOST = 6;
const isGrass = (kind: string): boolean => kind.startsWith('Grass');

/** The full near plan: everything out to NEAR_RADIUS_M, plus the dense grass carpet close in. */
function nearPlan(patches: readonly PatchView[], focus: { x: number; z: number }, groundAt: HeightSampler): Map<string, PlacedPlant[]> {
  const plan = planVegetation(patches, focus, NEAR_RADIUS_M, groundAt);
  const dense = planVegetation(patches, focus, DENSE_RADIUS_M, groundAt, { boost: DENSE_BOOST, only: isGrass, salt: 1 });
  for (const [kind, items] of dense) plan.set(kind, [...(plan.get(kind) ?? []), ...items]);
  return plan;
}
const REPLAN_STEP_M = 60;

interface KindMeshes { meshes: THREE.InstancedMesh[] }

/**
 * Draws the near-field plan. Each kind's model is split into its meshes (a tree is bark and
 * leaves), each an InstancedMesh sized for the densest ring, and refilled when the camera's
 * focus has moved far enough to matter.
 */
export class NearVegetation {
  readonly root = new THREE.Group();
  readonly #loader = new GLTFLoader();
  readonly #kinds = new Map<string, KindMeshes>();
  #lastFocus: { x: number; z: number } | null = null;
  #ready = false;

  constructor(
    private readonly patches: readonly PatchView[],
    private readonly groundAt: HeightSampler,
    private readonly base = '/assets/nature/',
  ) {
    this.root.name = 'near-vegetation';
  }

  async load(): Promise<void> {
    // The largest ring any kind can fill, from the plan at the densest point of the world.
    const capacity = new Map<string, number>();
    for (const patch of this.patches) {
      const centre = patchCentre(patch.id);
      const plan = nearPlan(this.patches, centre, () => 0);
      for (const [kind, items] of plan) capacity.set(kind, Math.max(capacity.get(kind) ?? 0, items.length));
    }
    await Promise.all(Object.entries(NATURE_KINDS).map(async ([kind, spec]) => {
      const max = capacity.get(kind) ?? 0;
      if (max === 0) return;
      const gltf = await this.#loader.loadAsync(this.base + spec.file);
      gltf.scene.updateMatrixWorld(true);
      const meshes: THREE.InstancedMesh[] = [];
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        // The pack's vertex colours are wind masks for its own shader, not colour. Multiplied into
        // the albedo they turned grass and leaves nearly black.
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          (material as THREE.MeshStandardMaterial).vertexColors = false;
          material.needsUpdate = true;
        }
        const instanced = new THREE.InstancedMesh(geometry, mesh.material, max);
        instanced.name = `nature:${kind}`;
        instanced.count = 0;
        instanced.castShadow = kind.includes('Tree');
        instanced.receiveShadow = true;
        instanced.frustumCulled = false; // instances span the whole ring
        meshes.push(instanced);
        this.root.add(instanced);
      });
      this.#kinds.set(kind, { meshes });
    }));
    this.#ready = true;
  }

  /** Refills the ring around `focus` when it has moved far enough. Returns true if it did. */
  update(focus: { x: number; z: number }): boolean {
    if (!this.#ready) return false;
    const last = this.#lastFocus;
    if (last !== null && Math.hypot(focus.x - last.x, focus.z - last.z) < REPLAN_STEP_M) return false;
    this.#lastFocus = { x: focus.x, z: focus.z };

    const plan = nearPlan(this.patches, focus, this.groundAt);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (const [kind, { meshes }] of this.#kinds) {
      const items = plan.get(kind) ?? [];
      for (const mesh of meshes) {
        const n = Math.min(items.length, mesh.instanceMatrix.count);
        for (let i = 0; i < n; i++) {
          const item = items[i]!;
          rotation.setFromAxisAngle(up, item.rotY);
          matrix.compose(position.set(item.x, item.y, item.z), rotation, scale.setScalar(item.scale));
          mesh.setMatrixAt(i, matrix);
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    return true;
  }
}
