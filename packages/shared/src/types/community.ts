import type { WorldPosition } from '../spatial.js';
import type { CommunityMotion } from '../communityMotion.js';

/** Opt-in at world creation only; never inject people into a saved animal world. */
export type CommunityProfile = 'none' | 'household_v1';
export type HumanAction = 'gather_food' | 'collect_water' | 'gather_timber' | 'gather_fibre'
  | 'deliver' | 'eat' | 'drink' | 'sleep' | 'build' | 'rest' | 'fish' | 'cook' | 'repair' | 'seek_resources' | 'hunt' | 'care_child';
export interface CommunityInventory {
  foodKg: number; timberKg: number; fibreKg: number; waterL: number;
  /** Required by household rules v2. Raw catch is not edible prepared food. */
  rawFishKg?: number;
  /** Rules v6: meat taken from an actual carcass; never edible until cooked. */
  rawMeatKg?: number;
}
export interface HumanTask {
  kind: HumanAction;
  phase: 'travel' | 'work';
  destination: WorldPosition;
  remainingSeconds: number;
  startedAt: number;
  eventId: string;
  /** Rules v5: remaining cardinal land-route waypoints, consumed only by actual travel. */
  journey?: { destinationPatchId: number; waypoints: WorldPosition[] };
  /** Rules v6: the individual animal observed when this attempt began. */
  targetAgentId?: string;
  /** Rules v7: the persistent child observed when a care trip began. */
  targetPersonId?: string;
}
export interface Person {
  id: string;
  name: string;
  householdId: string;
  appearanceSeed: number;
  ageDays: number;
  massKg: number;
  alive: boolean;
  diedAt: number | null;
  patchId: number;
  position: WorldPosition;
  needs: { hunger: number; thirst: number; fatigue: number };
  health: number;
  skills: { gathering: number; building: number; fishing?: number; hunting?: number };
  inventory: CommunityInventory;
  task: HumanTask | null;
  /** Bounded memories of actual local failures; no remote omniscience. */
  retryAfter: Partial<Record<HumanAction, number>>;
  /** Rules v5 exploration memory: visited sites, not live knowledge of distant resources. */
  visitedSites?: Array<{ patchId: number; at: number }>;
  /** Rules v7 kinship; presentation model choice does not determine reproductive role. */
  bornAt?: number;
  motherId?: string | null;
  fatherId?: string | null;
  generation?: number;
  reproductiveRole?: 'gestational' | 'non_gestational';
  lastBirthAt?: number | null;
  pregnancy?: { fatherId: string; conceivedAt: number; dueAt: number; fetusKg: number; conceivedEventId: string } | null;
}
export type HumanSkill = 'gathering' | 'building' | 'fishing' | 'hunting';
export interface HumanLesson {
  learnerId: string;
  teacherId: string;
  skill: HumanSkill;
  observedSeconds: number;
  gain: number;
  /** Last emitted learning milestone; preserved across checkpoints. */
  reportedGain: number;
}
export interface HumanRelationship {
  /** Canonical sorted pair, created by actual co-work rather than household membership. */
  members: [string, string];
  sharedWorkSeconds: number;
  lastInteractionAt: number;
  trust: number;
  /** Completed shared-work hours already emitted as milestones. */
  reportedHours: number;
  lessons: HumanLesson[];
}
export type BuildingStage = 'site' | 'frame' | 'walls' | 'roof' | 'occupied';
export interface CommunityBuilding {
  id: string;
  position: WorldPosition;
  stage: BuildingStage;
  /** Work on the current stage only; paid materials remain in the building stock. */
  labourSeconds: number;
  materials: { timberKg: number; fibreKg: number };
  completedAt: number | null;
  occupantIds: string[];
  /** Rules v4 only. Material condition is derived from retained timber/fibre, not a second stock. */
  maintenance?: { repairsCompleted: number; lastRepairAt: number | null;
    /** Rules v8: a collapsed home returns to site and must earn every stage again. */
    collapses?: number; lastCollapseAt?: number | null; lastCollapseEventId?: string | null; rebuildsCompleted?: number;
  };
}
export interface CommunityState {
  /** Observational recording only; absent in older checkpoints. Never drives decisions. */
  motion?: CommunityMotion;
  profile: 'household_v1';
  /** Rules pin: older households never silently acquire later food or learning rules. */
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  id: string;
  name: string;
  householdId: string;
  foundedAt: number;
  updatedAt: number;
  patchId: number;
  stores: CommunityInventory;
  people: Person[];
  /** Rules v7: monotonic child ID allocation, never inferred from current array length. */
  nextPersonSeq?: number;
  building: CommunityBuilding;
  /** Present in rules v3 and later; at most one edge per pair of this household's people. */
  relationships?: HumanRelationship[];
}

/** Abstract pole-and-fibre home. Values are simulation parameters, not architectural claims. */
export const HOME_STAGES = [
  { from: 'site', to: 'frame', timberKg: 48, fibreKg: 8, labourSeconds: 28_800 },
  { from: 'frame', to: 'walls', timberKg: 32, fibreKg: 24, labourSeconds: 43_200 },
  { from: 'walls', to: 'roof', timberKg: 16, fibreKg: 40, labourSeconds: 43_200 },
  { from: 'roof', to: 'occupied', timberKg: 0, fibreKg: 0, labourSeconds: 7_200 },
] as const;

export const HOME_MATERIAL_CAPACITY = { timberKg: 96, fibreKg: 72 } as const;
export const HOME_SHELTER_THRESHOLD = .4;
/** A completed home needs both frame and covering. Construction stages are not habitable. */
export function homeCondition(state: CommunityState): number {
  if (state.building.stage !== 'occupied') return 0;
  if (state.version < 4) return 1;
  return Math.max(0, Math.min(1, state.building.materials.timberKg / HOME_MATERIAL_CAPACITY.timberKg,
    state.building.materials.fibreKg / HOME_MATERIAL_CAPACITY.fibreKg));
}

export const emptyCommunityInventory = (): CommunityInventory => ({ foodKg: 0, timberKg: 0, fibreKg: 0, waterL: 0, rawFishKg: 0 });
export function communityBiomassKg(state: CommunityState | null | undefined): number {
  if (!state) return 0;
  const mass = (stock: CommunityInventory) => stock.foodKg + stock.timberKg + stock.fibreKg + (stock.rawFishKg ?? 0) + (stock.rawMeatKg ?? 0);
  return mass(state.stores) + state.building.materials.timberKg + state.building.materials.fibreKg
    + state.people.reduce((sum, p) => sum + p.massKg + mass(p.inventory) + (p.pregnancy?.fetusKg ?? 0), 0);
}
