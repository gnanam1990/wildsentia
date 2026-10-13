import { worldGrid } from './worldGrid.js';
import * as THREE from 'three';
import { ObstacleField, obstaclesFrom } from './obstacles.js';
import { treeAnchorForPatch, treeAnchorRemnantForPatch } from '@vana/shared';
import { patchCentre } from './space.js';
import { terrainHeightKey, type HeightSampler, type PatchView } from './terrain.js';
import { addTreeDetailFade, bakeTreeAtlas, treeFadeRangeFor, TREE_FADE_END_M, TREE_PLAN_MARGIN_M, type TreeAtlas } from './treeLod.js';
import { addCameraInteriorFade } from './observerVisibility.js';
import { ForestBatches } from './forestBatches.js';
import { addLeafLodFade, alternateLeafCards, LEAF_LOD_START_M, LEAF_LOD_END_M } from './leafLod.js';
import type { RenderTier } from './renderQuality.js';
import { preferenceFor, standSpot, treeAgeScale } from './forestStructure.js';
import { SWAY, swayFor, wind, type SwayProfile } from './wind.js';

/**
 * Poly Haven textured broadleaf trees/rocks plus Quaternius understory (CC0). Tree sources
 * are generic visual proxies, not species-accurate shola flora. The 8 m derivatives span
 * sapling and mature scales; each kind is instanced and shares its source's distant atlas.
 */
export const NATURE_KINDS: Record<string, { file: string; scale: [number, number] }> = {
  CommonTree_1:       { file: 'NaturalBroadleafSpreading.glb', scale: [1.25, 2.5] },
  CommonTree_2:       { file: 'NaturalBroadleafUpright.glb', scale: [1.4, 2.7] },
  CommonTree_3:       { file: 'NaturalBroadleafUpright.glb', scale: [0.65, 1.5] },
  CommonTree_4:       { file: 'NaturalBroadleafSpreading.glb', scale: [0.8, 1.8] },
  TwistedTree_1:      { file: 'NaturalBroadleafSpreading.glb', scale: [1.35, 2.5] },
  TwistedTree_3:      { file: 'NaturalBroadleafUpright.glb', scale: [1.5, 2.7] },
  DeadTree_2:         { file: 'DeadTree_2.glb', scale: [0.8, 1.1] },
  Bush_Common:        { file: 'Bush_Common.glb', scale: [0.6, 1.7] },
  Bush_Common_Flowers:{ file: 'Bush_Common_Flowers.glb', scale: [0.7, 1.1] },
  Fern_1:             { file: 'Fern_1.glb', scale: [0.3, 0.6] },
  Plant_1_Big:        { file: 'Plant_1_Big.glb', scale: [0.25, 0.4] },
  Plant_7_Big:        { file: 'Plant_7_Big.glb', scale: [0.4, 0.7] },
  Grass_Common_Tall:  { file: 'Grass_Common_Tall.glb', scale: [0.35, 0.55] },
  Grass_Common_Short: { file: 'Grass_Common_Short.glb', scale: [0.25, 0.4] },
  Grass_Wispy_Tall:   { file: 'Grass_Wispy_Tall.glb', scale: [0.45, 0.65] },
  Flower_3_Group:     { file: 'Flower_3_Group.glb', scale: [0.2, 0.3] },
  Flower_4_Group:     { file: 'Flower_4_Group.glb', scale: [0.2, 0.3] },
  Clover_1:           { file: 'Clover_1.glb', scale: [0.15, 0.25] },
  Rock_Medium_1:      { file: 'NaturalBoulder.glb', scale: [0.4, 1.1] },
  Rock_Medium_2:      { file: 'NaturalStone.glb', scale: [0.4, 1.1] },
  Rock_Medium_3:      { file: 'NaturalBoulder.glb', scale: [0.4, 1.0] },
  Stone_Small:        { file: 'NaturalStone.glb', scale: [0.06, 0.22] },
  Boulder_Large:      { file: 'NaturalBoulder.glb', scale: [1.5, 3.4] },
  Mushroom_Common:    { file: 'Mushroom_Common.glb', scale: [0.25, 0.4] },
};

/** Source-space root footprints measured from the packaged 8 m tree derivatives.
 * The spreading scan includes a soil skirt; the upright scan has a narrow trunk base.
 * Seating is presentation-only, shared by the detailed mesh and its distant atlas. */
export const TREE_ROOT_SEATING: Readonly<Record<string, { radius: number; embed: number }>> = {
  'NaturalBroadleafSpreading.glb': { radius: 1.1, embed: 0.28 },
  'NaturalBroadleafUpright.glb': { radius: 0.25, embed: 0.05 },
};
export const ROCK_SEATING: Readonly<Record<string, { radius: number; embed: number }>> = {
  'NaturalBoulder.glb': { radius: 1.1, embed: 0.12 },
  'NaturalStone.glb': { radius: 1.25, embed: 0.10 },
};

/** Keep the reviewed PNG sources available for browsers without WebP support. */
export function natureAssetFile(file: string, webpSupported: boolean): string {
  if (!webpSupported) return file;
  if (file === 'NaturalBroadleafSpreading.glb') return 'NaturalBroadleafSpreadingWebP.glb';
  if (file === 'NaturalBroadleafUpright.glb') return 'NaturalBroadleafUprightWebP.glb';
  return file;
}

function canUseWebP(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    return canvas.toDataURL('image/webp').startsWith('data:image/webp');
  }
  catch { return false; }
}

export function vegetationGroundHeight(kind: string, x: number, z: number, scale: number, groundAt: HeightSampler): number {
  let floor = groundAt(x, z);
  const file = NATURE_KINDS[kind]?.file ?? '';
  const seating = TREE_ROOT_SEATING[file] ?? ROCK_SEATING[file];
  if (!seating) return floor;
  const dimensions = natureScale(kind, { x, y: floor, z, rotY: 0, scale });
  // Seat against the low side of the footprint, not just its centre. The terrain is a
  // coarse continuous mesh; eight bounded perimeter samples avoid hovering downhill skirts.
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4, radius = seating.radius * Math.max(dimensions[0], dimensions[2]);
    const sampled = groundAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
    if (Number.isFinite(sampled)) floor = Math.min(floor, sampled);
  }
  return floor - seating.embed * dimensions[1];
}

type Driver = 'grass' | 'canopy' | 'fixed';

/**
 * How many canopy trees a patch carries, relative to a typical closed forest. Rounded to a
 * hundredth so an imperceptible canopy change neither moves a tree nor invalidates a cache.
 */
const canopyFactor = (patch: PatchView | undefined): number =>
  !patch || patch.surface === 'ocean' || patch.surface === 'coast' ? 0
    : Math.round(Math.min(1.3, (patch.canopyCover ?? 0) / 0.7) * 100) / 100;

/**
 * Canopy density anywhere on the island, blended between patch centres. Trees are planned per
 * 300 m patch, so a forest used to end in a straight line at the patch edge and read as a
 * square from above. Thinning each tree by the blended density where it stands gives forests
 * soft, natural edges without moving any tree that stays.
 */
export function canopyField(patches: readonly PatchView[]): (x: number, z: number) => number {
  const byId = new Map(patches.map((p) => [p.id, p]));
  const at = (col: number, row: number): number =>
    col < 0 || row < 0 || col >= worldGrid().cols || row >= worldGrid().cols ? 0 : canopyFactor(byId.get(row * worldGrid().cols + col));
  return (x, z) => {
    const gx = x / worldGrid().patchM, gz = z / worldGrid().patchM;
    const col = Math.floor(gx), row = Math.floor(gz), fx = gx - col, fz = gz - row;
    return (at(col, row) * (1 - fx) + at(col + 1, row) * fx) * (1 - fz)
      + (at(col, row + 1) * (1 - fx) + at(col + 1, row + 1) * fx) * fz;
  };
}

/** A fixed 0-1 value for a spot, so thinning never reshuffles which trees stand. */
const spotHash = (x: number, z: number): number => {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

function placementCount(patch: PatchView, perPatch: number, driver: Driver, boost = 1): number {
  const grass = patch.water > 20_000 ? 0 : Math.min(1, Math.max(0, patch.grass / 6000));
  const canopy = Math.min(1.3, (patch.canopyCover ?? 0) / 0.7);
  return Math.round(boost * perPatch * (driver === 'grass' ? grass : driver === 'canopy' ? canopy : 1));
}

/** What grows in a 300 m patch of each habitat at full vigour, and what drives how much. */
const HABITAT_MIX: Record<string, Array<[kind: string, perPatch: number, driver: Driver]>> = {
  grassland: [
    ['Grass_Common_Tall', 180, 'grass'], ['Grass_Common_Short', 220, 'grass'],
    ['Grass_Wispy_Tall', 90, 'grass'], ['Clover_1', 40, 'grass'],
    ['Flower_3_Group', 18, 'grass'], ['Flower_4_Group', 12, 'grass'],
    ['Bush_Common', 100, 'fixed'], ['CommonTree_3', 18, 'fixed'], ['CommonTree_4', 10, 'fixed'],
    ['Stone_Small', 280, 'fixed'], ['Rock_Medium_1', 48, 'fixed'], ['Boulder_Large', 14, 'fixed'],
  ],
  shola: [
    ['CommonTree_1', 360, 'canopy'], ['CommonTree_2', 340, 'canopy'], ['CommonTree_4', 300, 'canopy'],
    ['Fern_1', 1200, 'fixed'], ['Bush_Common', 480, 'fixed'], ['Plant_1_Big', 400, 'fixed'],
    ['Mushroom_Common', 12, 'fixed'], ['Grass_Common_Short', 60, 'grass'],
    ['Stone_Small', 180, 'fixed'], ['Rock_Medium_2', 75, 'fixed'], ['Boulder_Large', 24, 'fixed'],
  ],
  riparian: [
    ['TwistedTree_1', 100, 'canopy'], ['TwistedTree_3', 100, 'canopy'], ['CommonTree_2', 280, 'canopy'],
    ['Bush_Common_Flowers', 180, 'fixed'], ['Fern_1', 250, 'fixed'],
    ['Grass_Wispy_Tall', 140, 'grass'], ['Plant_7_Big', 30, 'fixed'],
    ['Stone_Small', 180, 'fixed'], ['Rock_Medium_3', 60, 'fixed'], ['Boulder_Large', 18, 'fixed'],
  ],
  marsh: [
    ['Grass_Wispy_Tall', 260, 'grass'], ['Plant_7_Big', 50, 'fixed'], ['Clover_1', 40, 'grass'],
    ['Stone_Small', 50, 'fixed'], ['Rock_Medium_2', 12, 'fixed'],
  ],
  rock: [
    ['Rock_Medium_1', 100, 'fixed'], ['Rock_Medium_2', 100, 'fixed'], ['Rock_Medium_3', 80, 'fixed'],
    ['Stone_Small', 350, 'fixed'], ['Boulder_Large', 65, 'fixed'],
    ['DeadTree_2', 2, 'fixed'], ['Grass_Common_Short', 40, 'grass'],
  ],
  water: [],
};

export interface PlacedPlant { x: number; y: number; z: number; rotY: number; scale: number }

/** Local asset multipliers, not metres. Flattened stones and broad/tall boulders
 * break the repeated-model silhouette without another mesh or draw call. */
export function natureScale(kind: string, item: PlacedPlant): [number, number, number] {
  if (!/^(Stone_|Rock_|Boulder_)/.test(kind)) return [item.scale, item.scale, item.scale];
  const variation = (Math.sin(item.x * 12.9898 + item.z * 78.233) * 43758.5453) % 1;
  const shape = Math.abs(variation);
  return [item.scale * (0.85 + shape * 0.55), item.scale * (0.55 + shape * 0.6), item.scale * (1.25 - shape * 0.4)];
}

/** Several presentation kinds reuse one loaded GLB node at different placement scales.
 * Flatten its immutable local geometry once, while keeping each kind's material and
 * instance matrix independent. Key by mesh, not geometry: separate GLB nodes can
 * share a source buffer but have different world transforms. */
export function flattenedNatureGeometry(mesh: THREE.Mesh, cache: WeakMap<THREE.Mesh, THREE.BufferGeometry>): THREE.BufferGeometry {
  let geometry = cache.get(mesh);
  if (!geometry) {
    geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    cache.set(mesh, geometry);
  }
  return geometry;
}

export interface PlanOptions {
  /** Multiplies how many of each kind grow; for a denser carpet close to the camera. */
  boost?: number;
  /** Plans only the kinds this accepts. */
  only?: (kind: string) => boolean;
  /** Varies placement so a second pass does not stack plants on the first. */
  salt?: number;
  /** Optional tighter per-kind visibility budget, applied before costly terrain seating. */
  radiusForKind?: (kind: string) => number;
  /** Blended canopy density (canopyField); thins canopy trees toward forest edges. */
  canopyAt?: (x: number, z: number) => number;
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
  const reach = radiusM + worldGrid().patchM;
  for (const patch of patches) {
    if (patch.surface === 'ocean' || patch.surface === 'coast') continue;
    const centre = patchCentre(worldGrid(), patch.id);
    const anchor = treeAnchorForPatch(worldGrid(), patch);
    if (Math.abs(centre.x - focus.x) > reach || Math.abs(centre.z - focus.z) > reach) continue;
    // The nearest point of this 300 m square gives a conservative no-placement test.
    // Skip thousands of deterministic RNG iterations when a tighter near-kind radius
    // cannot intersect this patch at all; remaining patch/kind seeds are independent.
    const nearX = Math.max(0, Math.abs(centre.x - focus.x) - worldGrid().patchM / 2);
    const nearZ = Math.max(0, Math.abs(centre.z - focus.z) - worldGrid().patchM / 2);
    const nearestInPatch = Math.hypot(nearX, nearZ);
    const mix = HABITAT_MIX[patch.habitat] ?? [];
    mix.forEach(([kind, perPatch, driver], k) => {
      if (options.only !== undefined && !options.only(kind)) return;
      const kindRadius = Math.min(radiusM, options.radiusForKind?.(kind) ?? radiusM);
      if (nearestInPatch > kindRadius) { plan.set(kind, plan.get(kind) ?? []); return; }
      const count = placementCount(patch, perPatch, driver, boost);
      let seed = (patch.id * 73_856_093) ^ ((k + 1) * 19_349_663) ^ (salt * 83_492_791);
      const random = (): number => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 4_294_967_296;
      };
      const [lo, hi] = NATURE_KINDS[kind]!.scale;
      const list = plan.get(kind) ?? [];
      // Clumps and clearings from the fixed stand pattern (forestStructure.ts): the patch keeps
      // its simulated count, only where each plant stands and how old a tree looks change.
      const preference = preferenceFor(kind, patch.habitat);
      for (let i = 0; i < count; i++) {
        const spot = standSpot(random, centre, worldGrid().patchM, preference);
        const plannedX = spot.x;
        const plannedZ = spot.z;
        const rotY = random() * Math.PI * 2;
        const plannedScale = preference === 'canopy' || preference === 'grove'
          ? treeAgeScale(lo, hi, random(), spot.stand).scale : lo + (hi - lo) * random();
        // Reuse one of the already-budgeted visible instances; no extra draw call or tree.
        const placedAnchor = i === 0 && anchor?.visualKind === kind;
        const x = placedAnchor ? anchor.x : plannedX;
        const z = placedAnchor ? anchor.z : plannedZ;
        const scale = placedAnchor ? anchor.visualScale : plannedScale;
        if (Math.hypot(x - focus.x, z - focus.z) > kindRadius) continue;
        // Toward an edge the blended canopy falls below this patch's own; keep that share.
        // A climbing anchor always stands.
        if (driver === 'canopy' && !placedAnchor && options.canopyAt) {
          const own = canopyFactor(patch);
          if (own > 0 && spotHash(x, z) >= Math.min(1, options.canopyAt(x, z) / own) ** 1.5) continue;
        }
        list.push({ x, y: vegetationGroundHeight(kind, x, z, scale, groundAt), z, rotY, scale });
      }
      plan.set(kind, list);
    });
    const remnant = treeAnchorRemnantForPatch(worldGrid(), patch);
    const remnantRadius = Math.min(radiusM, options.radiusForKind?.('DeadTree_2') ?? radiusM);
    if (remnant && (options.only === undefined || options.only('DeadTree_2'))
      && Math.hypot(remnant.x - focus.x, remnant.z - focus.z) <= radiusM) {
      const scale = 1.8;
      const list = plan.get('DeadTree_2') ?? [];
      if (Math.hypot(remnant.x - focus.x, remnant.z - focus.z) <= remnantRadius)
        list.push({ x: remnant.x, y: vegetationGroundHeight('DeadTree_2', remnant.x, remnant.z, scale, groundAt),
          z: remnant.z, rotY: 0, scale });
      plan.set('DeadTree_2', list);
    }
  }
  return plan;
}

/** Near-field detail radius, and how far the focus moves before the plan is rebuilt. */
export const NEAR_RADIUS_M = 220;
export const TREE_DETAIL_RADIUS_M = TREE_FADE_END_M + TREE_PLAN_MARGIN_M;
const PROP_DETAIL_RADIUS_M = NEAR_RADIUS_M;
const isTree = (kind: string): boolean => kind.includes('Tree');

interface CachedTrees { key: string; plan: Map<string, PlacedPlant[]> }

/** One bounded cache of the world's actual tree placements, independent of grass checkpoints.
 * Unchanged patch entries retain plant identity. A canopy change rebuilds only that patch;
 * seed/mainland heights or sampler replacement invalidate all root-contact calculations.
 * Call clear() if a custom sampler changes behaviour without changing its identity/patch heights. */
export class TreePlacementCache {
  readonly #patches = new Map<number, CachedTrees>();
  #order: CachedTrees[] = [];
  #plan = new Map<string, PlacedPlant[]>();
  #heightKey: string | null = null;
  #ground: HeightSampler | null = null;

  clear(): void { this.#patches.clear(); this.#order = []; this.#plan = new Map(); this.#heightKey = null; this.#ground = null; }

  get(patches: readonly PatchView[], groundAt: HeightSampler): Map<string, PlacedPlant[]> {
    const height = terrainHeightKey(patches);
    if (height !== this.#heightKey || groundAt !== this.#ground) {
      this.clear(); this.#heightKey = height; this.#ground = groundAt;
    }
    const order: CachedTrees[] = [], ids = new Set<number>();
    const canopyAt = canopyField(patches);
    const byId = new Map(patches.map((p) => [p.id, p]));
    for (const patch of patches) {
      ids.add(patch.id);
      const counts = (HABITAT_MIX[patch.habitat] ?? []).filter(([kind]) => isTree(kind))
        .map(([kind, perPatch, driver]) => [kind, placementCount(patch, perPatch, driver)]);
      const col = patch.id % worldGrid().cols, row = Math.floor(patch.id / worldGrid().cols);
      const neighbours = [-1, 0, 1].flatMap((dr) => [-1, 0, 1].map((dc) =>
        col + dc < 0 || col + dc >= worldGrid().cols ? 0 : canopyFactor(byId.get((row + dr) * worldGrid().cols + col + dc))));
      const key = JSON.stringify([patch.id, patch.habitat, patch.surface ?? 'land', counts,
        treeAnchorRemnantForPatch(worldGrid(), patch) !== null, neighbours]);
      let entry = this.#patches.get(patch.id);
      if (!entry || entry.key !== key) {
        entry = { key, plan: planVegetation([patch], { x: 2850, z: 2850 }, 4500, groundAt, { only: isTree, canopyAt }) };
        this.#patches.set(patch.id, entry);
      }
      order.push(entry);
    }
    for (const id of this.#patches.keys()) if (!ids.has(id)) this.#patches.delete(id);
    if (order.length === this.#order.length && order.every((entry, i) => entry === this.#order[i])) return this.#plan;
    const plan = new Map<string, PlacedPlant[]>();
    for (const entry of order) for (const [kind, plants] of entry.plan) {
      let list = plan.get(kind);
      if (!list) { list = []; plan.set(kind, list); }
      for (const plant of plants) list.push(plant);
    }
    this.#order = order; this.#plan = plan;
    return plan;
  }
}

/** The full near plan: everything out to NEAR_RADIUS_M, plus the dense grass carpet close in. */
export function nearPlan(patches: readonly PatchView[], focus: { x: number; z: number }, groundAt: HeightSampler,
  treeDetailRadiusM = TREE_DETAIL_RADIUS_M): Map<string, PlacedPlant[]> {
  return planVegetation(patches, focus, PROP_DETAIL_RADIUS_M, groundAt, {
    radiusForKind: kind => isTree(kind) ? treeDetailRadiusM : kind.startsWith('Grass') ? 90 : PROP_DETAIL_RADIUS_M,
    // The same thinning as the distant forest, so a tree never appears or vanishes at the fade.
    canopyAt: canopyField(patches),
  });
}

const REPLAN_STEP_M = 20;

/** The densest even forest the planner ever made: a full-canopy shola patch's trees per m². */
export const TREE_DETAIL_DENSITY_CAP = HABITAT_MIX.shola!.filter(([kind]) => isTree(kind))
  .reduce((sum, [, perPatch]) => sum + perPatch, 0) * 1.3 / worldGrid().patchM ** 2;
/** Never pull detailed trees in closer than this share of the tier's fade distances. */
export const MIN_CLUMP_DETAIL_SCALE = 0.6;

/**
 * How far to shrink the detailed-tree radius around `focus` so standing inside a dense clump
 * costs no more full tree geometry than the densest evenly spread forest did. Clumping keeps
 * every patch's tree count but packs them closer; the extra trees beyond the shrunken radius
 * are drawn by their matching atlas cards instead. 1 everywhere else.
 */
export function clumpDetailScale(plan: ReadonlyMap<string, readonly PlacedPlant[]>, focus: { x: number; z: number },
  endM: number): number {
  const distances: number[] = [];
  for (const [kind, items] of plan) {
    if (!isTree(kind)) continue;
    for (const item of items) {
      const distance = Math.hypot(item.x - focus.x, item.z - focus.z);
      if (distance <= endM) distances.push(distance);
    }
  }
  const allowed = Math.floor(Math.PI * endM * endM * TREE_DETAIL_DENSITY_CAP);
  if (distances.length <= allowed) return 1;
  // The radius holding exactly the allowed number of nearest trees.
  distances.sort((a, b) => a - b);
  return Math.max(MIN_CLUMP_DETAIL_SCALE, distances[allowed]! / endM);
}


interface KindMeshes { meshes: THREE.InstancedMesh[]; bounds: THREE.Sphere }
interface DistantTrees { batches: ForestBatches; atlas: TreeAtlas }

/**
 * Draws the near-field plan. Each kind's model is split into its meshes (a tree is bark and
 * leaves), each an InstancedMesh sized for the densest ring, and refilled when the camera's
 * focus has moved far enough to matter.
 */
export class NearVegetation {
  readonly root = new THREE.Group();
  readonly #lifetime = new AbortController();
  readonly #kinds = new Map<string, KindMeshes>();
  readonly #distant = new Map<string, DistantTrees>();
  readonly #observer = { value: new THREE.Vector3() };
  readonly #treeFade = { value: treeFadeRangeFor('high') };
  /** The tier's fade range before any dense-clump shrink (clumpDetailScale). */
  readonly #tierFade = treeFadeRangeFor('high');
  #quality: RenderTier = 'high';
  readonly #treeCache = new TreePlacementCache();
  #nearPlan: Map<string, PlacedPlant[]> | null = null;
  /** Trunks and boulders of the current near plan, for animals to walk around. */
  obstacles = new ObstacleField();
  #viewMatrix: THREE.Matrix4 | null = null;
  readonly #drawnItems = new Map<string, readonly PlacedPlant[]>();
  #lastFocus: { x: number; y: number; z: number } | null = null;
  #ready = false;

  constructor(
    private patches: readonly PatchView[],
    private readonly groundAt: HeightSampler,
    private readonly base = '/assets/nature/',
  ) {
    this.root.name = 'near-vegetation';
  }

  setPatches(patches: readonly PatchView[]): void {
    this.patches = patches;
    this.#lastFocus = null;
    this.#nearPlan = null;
  }

  async load(renderer?: THREE.WebGLRenderer): Promise<void> {
    this.#lifetime.signal.throwIfAborted();
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    this.#lifetime.signal.throwIfAborted();
    const loader = new GLTFLoader();
    const webpSupported = canUseWebP();
    // Grow buffers on demand. Scanning all 400 possible camera locations delayed first grass.
    const files = new Map<string, ReturnType<typeof loader.loadAsync>>();
    const flattened = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();
    const sparseLeaves = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry | null>();
    const loaded = await Promise.allSettled(Object.entries(NATURE_KINDS).map(async ([kind, spec]) => {
      // A currently barren patch can regrow; keep every model available for future updates.
      const max = 32;
      let pending = files.get(spec.file);
      if (!pending) { pending = loader.loadAsync(this.base + natureAssetFile(spec.file, webpSupported)); files.set(spec.file, pending); }
      const gltf = await pending;
      gltf.scene.updateMatrixWorld(true);
      const meshes: THREE.InstancedMesh[] = [];
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geometry = flattenedNatureGeometry(mesh, flattened);
        // The pack's vertex colours are wind masks for its own shader, not colour. Multiplied into
        // the albedo they turned grass and leaves nearly black.
        // A source file can supply several placement kinds. Own each kind's shader/material:
        // otherwise fading one kind contaminates the next kind's atlas bake.
        const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => m.clone());
        for (const material of materials) {
          (material as THREE.MeshStandardMaterial).vertexColors = false;
          // This free pack's twisted foliage is autumn-red. Keep its leaf detail/alpha but
          // use an evergreen understory palette for this biome; source assets stay untouched.
          if (material.name === 'Leaves_TwistedTree') {
            material.onBeforeCompile = (shader) => {
              shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
                #include <map_fragment>
                float leafDetail = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
                diffuseColor.rgb = vec3(0.19, 0.38, 0.085) * (0.55 + leafDetail * 1.8);
              `);
            };
            material.customProgramCacheKey = () => 'vana-evergreen-foliage-v1';
          }
          material.needsUpdate = true;
        }
        const instanced = new THREE.InstancedMesh(geometry, Array.isArray(mesh.material) ? materials : materials[0]!, max);
        instanced.name = `nature:${kind}`;
        let leafGeometry: THREE.BufferGeometry | null = null;
        if (isTree(kind) && !Array.isArray(mesh.material) && /leaves/i.test(materials[0]?.name ?? '')) {
          leafGeometry = sparseLeaves.has(geometry) ? sparseLeaves.get(geometry)! : alternateLeafCards(geometry);
          sparseLeaves.set(geometry, leafGeometry);
        }
        if (leafGeometry) instanced.userData.leafLod = 'full';
        instanced.count = 0;
        instanced.castShadow = kind.includes('Tree') || kind.startsWith('Rock_') || kind === 'Boulder_Large';
        instanced.receiveShadow = true;
        instanced.frustumCulled = false; // instances span the whole ring
        meshes.push(instanced);
        this.root.add(instanced);
        if (leafGeometry) {
          const middle = new THREE.InstancedMesh(leafGeometry, materials[0]!.clone(), max);
          middle.name = `nature-lod:${kind}`;
          middle.userData.leafLod = 'middle'; middle.count = 0;
          middle.castShadow = instanced.castShadow; middle.receiveShadow = true;
          middle.frustumCulled = false;
          meshes.push(middle); this.root.add(middle);
        }
      });
      const box = new THREE.Box3();
      for (const mesh of meshes) { mesh.geometry.computeBoundingBox(); box.union(mesh.geometry.boundingBox!); }
      // Grass, leaves and branches lean with the observer's wind; bases and rocks stay put.
      const swayed = new Set<THREE.Material>();
      for (const mesh of meshes) {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const sway = swayFor(kind, material.name);
          if (!sway || swayed.has(material)) continue;
          swayed.add(material);
          wind.apply(material, { height: Math.max(0.1, box.max.y), ...SWAY[sway] });
        }
      }
      this.#kinds.set(kind, { meshes, bounds: box.getBoundingSphere(new THREE.Sphere()) });
    }));
    const failures = loaded.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) {
      this.dispose();
      throw new AggregateError(failures.map((result) => result.reason), 'Nature assets could not be loaded');
    }
    if (this.#lifetime.signal.aborted) { this.dispose(); this.#lifetime.signal.throwIfAborted(); }
    if (renderer) {
      try {
        const atlases = new Map<string, TreeAtlas>();
        // Bake before attaching the distance discard shader to the source geometry.
        for (const [kind, { meshes }] of this.#kinds) {
          if (!isTree(kind)) continue;
          const file = NATURE_KINDS[kind]!.file;
          let atlas = atlases.get(file);
          if (!atlas) {
            const seating = TREE_ROOT_SEATING[file];
            atlas = await bakeTreeAtlas(renderer, meshes.filter(mesh => mesh.userData.leafLod !== 'middle'),
              { signal: this.#lifetime.signal, ...(seating ? { clipBelow: seating.embed + 0.02 } : {}) });
            // If disposal happened in a promise continuation, this unowned result must not
            // be published or leak; established targets are released by dispose below.
            if (this.#lifetime.signal.aborted) { atlas.target.dispose(); this.#lifetime.signal.throwIfAborted(); }
            atlases.set(file, atlas);
          }
          const batches = new ForestBatches(atlas, kind, this.#treeFade);
          this.#distant.set(kind, { batches, atlas }); this.root.add(batches.root);
          for (const near of meshes) {
            const sourceMaterials = Array.isArray(near.material) ? near.material : [near.material];
            for (const material of sourceMaterials) {
              addTreeDetailFade(material, this.#observer, this.#treeFade);
              if (near.userData.leafLod === 'full' || near.userData.leafLod === 'middle')
                addLeafLodFade(material, near.userData.leafLod);
              addCameraInteriorFade(material, this.#observer, 'tree');
            }
            // Three's generated shadow material does not inherit onBeforeCompile.
            // Keep alpha-cut leaves and the camera-centred fade in the depth pass too.
            if (Array.isArray(near.material)) continue;
            const source = near.material as THREE.MeshStandardMaterial;
            const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking,
              map: source.map, alphaMap: source.alphaMap, alphaTest: source.alphaTest,
              side: source.shadowSide ?? source.side });
            const sway = source.userData.windSway as SwayProfile | undefined;
            if (sway) wind.apply(depth, sway);
            addTreeDetailFade(depth, this.#observer, this.#treeFade);
            if (near.userData.leafLod === 'full' || near.userData.leafLod === 'middle')
              addLeafLodFade(depth, near.userData.leafLod);
            addCameraInteriorFade(depth, this.#observer, 'tree');
            near.customDepthMaterial = depth;
          }
        }
        for (const [kind, { meshes }] of this.#kinds) {
          if (!kind.startsWith('Rock_') && kind !== 'Boulder_Large') continue;
          const materials = new Set(meshes.flatMap((m) => Array.isArray(m.material) ? m.material : [m.material]));
          for (const material of materials) addCameraInteriorFade(material, this.#observer, 'rock');
          for (const near of meshes) {
            if (Array.isArray(near.material)) continue;
            const source = near.material as THREE.MeshStandardMaterial;
            const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking,
              map: source.map, alphaMap: source.alphaMap, alphaTest: source.alphaTest,
              side: source.shadowSide ?? source.side });
            addCameraInteriorFade(depth, this.#observer, 'rock');
            near.customDepthMaterial = depth;
          }
        }
      } catch (error) { this.dispose(); throw error; }
    }
    this.#ready = true;
  }

  get hasTreeLod(): boolean { return this.#ready && this.#distant.size > 0; }

  setQuality(tier: RenderTier): void {
    if (this.#quality === tier) return;
    this.#quality = tier;
    this.#tierFade.copy(treeFadeRangeFor(tier));
    this.#treeFade.value.copy(this.#tierFade);
    // A stationary camera must refill near instances when the fade endpoint changes.
    this.#lastFocus = null;
  }


  /** This layer owns flattened geometry, cloned materials, loaded maps and atlas targets.
   * InstancedMesh.dispose alone only releases per-instance buffers. */
  dispose(): void {
    this.#lifetime.abort();
    this.#ready = false;
    for (const { batches } of this.#distant.values()) { batches.dispose(); this.root.remove(batches.root); }
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.root.traverse((object) => {
      const mesh = object as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      mesh.dispose(); geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
      if (mesh.customDepthMaterial) materials.add(mesh.customDepthMaterial);
    });
    // Render-target textures are owned/disposed by their target, not Texture.dispose.
    const atlasTextures = new Set([...this.#distant.values()].map(({ atlas }) => atlas.target.texture));
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !atlasTextures.has(value)) textures.add(value);
      }
      material.dispose();
    }
    for (const geometry of geometries) geometry.dispose();
    for (const texture of textures) texture.dispose();
    for (const target of new Set([...this.#distant.values()].map(({ atlas }) => atlas.target))) target.dispose();
    this.#kinds.clear(); this.#distant.clear(); this.#treeCache.clear(); this.#lastFocus = null;
    this.#nearPlan = null; this.#viewMatrix = null;
    this.#drawnItems.clear();
    this.root.clear();
  }

  /** Atlas is neutral daylight; keep it responsive to the same observer day/night exposure. */
  setDistantLight(daylight: number): void {
    for (const { batches } of this.#distant.values()) {
      batches.material.color.setScalar(0.3 + Math.max(0, Math.min(1, daylight)) * 0.5);
    }
  }

  /** Replans coverage after movement; refreshes view culling independently on camera turns.
   * Returns true only for a coverage replan, so callers do not refill world-wide fallback
   * buffers on every orbit frame. A false result does not mean visible matrices were unchanged. */
  update(focus: { x: number; y?: number; z: number }, camera?: THREE.PerspectiveCamera): boolean {
    if (!this.#ready) return false;
    const y = focus.y ?? this.groundAt(focus.x, focus.z);
    this.#observer.value.set(focus.x, y, focus.z);
    const last = this.#lastFocus;
    const moved = last === null || Math.hypot(focus.x - last.x, y - last.y, focus.z - last.z) >= REPLAN_STEP_M;
    let frustum: THREE.Frustum | undefined;
    if (camera) {
      camera.updateMatrixWorld();
      const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      if (!moved && this.#viewMatrix?.equals(matrix)) return false;
      this.#viewMatrix = matrix;
      frustum = new THREE.Frustum().setFromProjectionMatrix(matrix);
    } else if (!moved) return false;
    if (moved || !this.#nearPlan) {
      this.#lastFocus = { x: focus.x, y, z: focus.z };
      this.#nearPlan = nearPlan(this.patches, focus, this.groundAt, this.#tierFade.y + TREE_PLAN_MARGIN_M);
      // Near and far trees share this range, so a shrink inside a clump only swaps geometry for cards.
      this.#treeFade.value.copy(this.#tierFade).multiplyScalar(clumpDetailScale(this.#nearPlan, focus, this.#tierFade.y));
      this.obstacles = new ObstacleField(obstaclesFrom(this.#nearPlan));
    }
    const plan = this.#nearPlan;
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const sphere = new THREE.Sphere();
    for (const [kind, { meshes, bounds }] of this.#kinds) {
      const candidates = plan.get(kind) ?? [];
      let items = this.hasTreeLod && isTree(kind)
        ? candidates.filter((p) => Math.hypot(p.x - focus.x, p.y - y, p.z - focus.z) <= (camera ? this.#treeFade.value.y : TREE_DETAIL_RADIUS_M))
        : candidates;
      if (frustum) items = items.filter((item) => {
        // Retain close offscreen casters. Else use the entire rotated crown sphere,
        // never just its trunk point, so trees entering the view do not disappear.
        if (Math.hypot(item.x - focus.x, item.z - focus.z) < 30) return true;
        rotation.setFromAxisAngle(up, item.rotY);
        const dimensions = natureScale(kind, item);
        sphere.center.copy(bounds.center).multiply(scale.set(...dimensions)).applyQuaternion(rotation)
          .add(position.set(item.x, item.y, item.z));
        sphere.radius = bounds.radius * Math.max(...dimensions) + 20; // margin for offscreen shadow casters
        return frustum!.intersectsSphere(sphere);
      });
      for (let m = 0; m < meshes.length; m++) {
        let mesh = meshes[m]!;
        const level = this.hasTreeLod ? mesh.userData.leafLod : null;
        const active = level === 'full'
          ? items.filter(item => Math.hypot(item.x - focus.x, item.y - y, item.z - focus.z) <= LEAF_LOD_END_M)
          : level === 'middle'
            ? items.filter(item => Math.hypot(item.x - focus.x, item.y - y, item.z - focus.z) >= LEAF_LOD_START_M)
            : mesh.userData.leafLod === 'middle' ? [] : items;
        // A camera orbit often changes the frustum but not this mesh's membership.
        // Leave its GPU instance buffer untouched when the exact placement set is stable.
        const key = `${kind}:${m}`;
        const drawn = this.#drawnItems.get(key);
        if (drawn && drawn.length === active.length && active.every((item, i) => item === drawn[i])) continue;
        this.#drawnItems.set(key, active);
        if (active.length > mesh.instanceMatrix.count) {
          const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material, 2 ** Math.ceil(Math.log2(active.length)));
          grown.name = mesh.name; grown.castShadow = mesh.castShadow;
          grown.customDepthMaterial = mesh.customDepthMaterial;
          grown.userData.leafLod = mesh.userData.leafLod;
          grown.receiveShadow = mesh.receiveShadow; grown.frustumCulled = false;
          this.root.remove(mesh); mesh.dispose(); this.root.add(grown);
          meshes[m] = grown; mesh = grown;
        }
        const n = active.length;
        for (let i = 0; i < n; i++) {
          const item = active[i]!;
          rotation.setFromAxisAngle(up, item.rotY);
          matrix.compose(position.set(item.x, item.y, item.z), rotation, scale.set(...natureScale(kind, item)));
          mesh.setMatrixAt(i, matrix);
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (this.hasTreeLod && moved) {
      const treePlan = this.#treeCache.get(this.patches, this.groundAt);
      for (const [kind, { batches }] of this.#distant) {
        batches.setItems(treePlan.get(kind));
        batches.updateRange(focus);
      }
    }
    return moved;
  }
}
