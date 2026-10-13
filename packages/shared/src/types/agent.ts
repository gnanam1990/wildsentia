import type { PatchId } from './patch.js';
import type { WorldTime } from '../time.js';
import type { WorldPosition } from '../spatial.js';

export type AgentState =
  | 'resting' | 'grazing' | 'drinking' | 'travelling'
  | 'stalking' | 'chasing' | 'feeding' | 'fleeing' | 'dead'
  /** Walked out of this stretch of forest into the country around it. Alive, but gone. */
  | 'emigrated';

/** Congo 1B adds 'submerged': a diver under water, unseen and out of reach until `submergedUntil`. */
export type LocomotionMode = 'ground' | 'flight' | 'climb' | 'submerged';

/** Skills an animal learns, is taught, and loses with disuse (spec §8). */
export const SKILL_IDS = [
  'forage_efficiency', 'water_locations', 'predator_avoidance', 'stalk_technique',
] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export interface SkillState {
  /** 0-1. 0.5 leaves the mechanic it feeds exactly as it was tuned. */
  confidence: number;
  successes: number;
  failures: number;
  lastUsed: number;
  /** The parent who taught it most recently, or null if self-taught or innate. */
  taughtBy: string | null;
}

export const GOAL_IDS = [
  'find_food', 'find_water', 'rest', 'wander', 'hunt', 'scavenge', 'flee', 'breed',
  'care_for_young', 'follow_parent',
  'seek_nursing',
  'collect_pack_food', 'deliver_pack_food', 'wait_for_pack_food',
] as const;

export type Sex = 'male' | 'female';

export const LIFE_STAGES = ['newborn', 'juvenile', 'subadult', 'adult', 'elder'] as const;
export type LifeStage = (typeof LIFE_STAGES)[number];

export const TRAIT_IDS = [
  'sizeTendency', 'boldness', 'endurance', 'sensoryAcuity', 'diseaseResistance', 'coatVariant',
] as const;
export type TraitId = (typeof TRAIT_IDS)[number];

/** Every trait is 0-1. Inherited once at birth and fixed for life. */
export type Traits = Record<TraitId, number>;
export type GoalId = (typeof GOAL_IDS)[number];

export function isGoalId(value: string): value is GoalId {
  return (GOAL_IDS as readonly string[]).includes(value);
}

export interface Drives {
  hunger: number;
  thirst: number;
  fatigue: number;
  fear: number;
}

/** Generic simulated carrion-associated infection, not a real pathogen diagnosis. */
export interface Illness {
  kind: 'carrion_infection';
  phase: 'incubating' | 'active';
  sourceCarcassId: string;
  sourceMealEventId: string;
  contractedEventId: string;
  onsetEventId?: string;
  acquiredAt: WorldTime;
  incubationUntil: WorldTime;
  lastUpdatedAt: WorldTime;
  /** Episode burden, 0-1; sampled once, never by a renderer or narrator. */
  severity: number;
  /** Remaining recovery work, modified by reserves, rest and inherited resistance. */
  recoveryRemainingHours: number;
  /** Sampled exponential hazard budget; persisted so restart cannot reroll survival. */
  mortalityBudget: number;
}

export const illnessBurden = (agent: Pick<Agent, 'illness'>): number =>
  agent.illness?.phase === 'active' ? agent.illness.severity : 0;

/** A modelled contact injury, not a veterinary diagnosis or a tissue-mass ledger. */
export interface Wound {
  kind: 'contact_injury';
  phase: 'open' | 'infected';
  sourceHuntEventId: string;
  woundEventId: string;
  infectionEventId?: string;
  acquiredAt: WorldTime;
  lastUpdatedAt: WorldTime;
  severity: number;
  recoveryRemainingHours: number;
  /** Sampled once; never rerolled across checkpoints. */
  infectionBudget: number;
  mortalityBudget: number;
}

export interface Agent {
  id: string;
  speciesId: string;
  illness?: Illness;
  wound?: Wound;
  /** Who this predator is currently working on. Null for everything else. */
  targetId?: string | null;
  /** Bounded short-term memory of abandoned/failed targets, persisted with the animal. */
  failedHunts?: Array<{ preyId: string; retryAfter: WorldTime }>;
  /** 0-1. Spent by chases, recovered by rest. Separate from fatigue, which is whole-body. */
  stamina?: number;
  sex: Sex;
  ageDays: number;
  lifeStage: LifeStage;
  traits: Traits;
  /** Null for a founder. Everything born in the world names both. */
  motherId: string | null;
  fatherId: string | null;
  /** 0 for founders, one higher than the elder parent for everything born. */
  generation: number;
  /** Set while this animal still depends on its mother. */
  dependentOn: string | null;
  /**
   * sim_0.35.0: meat eaten beyond the day's hunger, held in the stomach and digested at the
   * daily intake rate. A predator with food in its gut is sated and does not start a hunt.
   * An energy-equivalent drive buffer; the meat's nutrients already went to soil when eaten.
   */
  gutKg?: number;
  /**
   * sim_0.37.0: body condition, 0-1, a running mean of the share of daily food need met by the
   * species' natural diet, for species whose reproduction tracks food (lifecycle.condition).
   * Absent until the first day is folded in (it then starts full).
   */
  condition?: number;
  /**
   * sim_0.37.0: the world day `day`'s food tally: kilograms eaten (bounded by a daily gut limit)
   * and the need they met from the natural diet (rooting and mast food).
   */
  gutFill?: { day: number; kg: number; naturalKg: number };
  /** Last completed boar maternal water transfer. Optional on old saves; birth time is the fresh-born baseline. */
  lastMaternalWaterAt?: WorldTime;
  /** Persistent rendezvous, never a position override. Established sites are not historical birth locations. */
  nursingSite?: { patchId: number; position: WorldPosition; establishedAt: WorldTime; origin: 'birth' | 'established' };
  /** Fractions of this young animal's daily needs transferred in the named world-day nursing cycle. */
  nursingIntake?: { cycle: number; foodDays: number; waterDays: number; contactSeconds: number; lastEnd: WorldTime; completed: boolean };
  /** Real, unassimilated carcass biomass; not also credited to the carrier's reserves or soil. */
  packFood?: { kg: number; moistureLPerKg: number; sourceCarcassId: string; sourceActorId: string;
    sourceEventId: string; collectedAt: WorldTime; expiresAt: WorldTime; recipientId: string; packId: string };
  /** Where it came from last tick, so wandering becomes patrolling rather than a random walk. */
  previousPatchId?: number | null;
  /** Remaining cardinal waypoints. Persisted so a partial journey survives a restart. */
  journey?: { goal: GoalId; destinationPatchId: number; route: number[] };
  /** The herd, troop, pack or family this animal belongs to. Null for solitary species. */
  groupId?: string | null;
  /** World time conception happened, or null. */
  pregnantSince: number | null;
  /** Gestation identity is independent of the transient hunting target. */
  pregnancyFatherId?: string | null;
  /** A female whose courtship failed is not receptive again until her next cycle. */
  nextOestrusAt?: number | null;
  /** World time this animal last gave birth, for the inter-birth interval. */
  lastBirthAt: number | null;
  offspringIds: string[];
  /** What it knows. A skill missing here is at the species' innate floor. */
  skills?: Partial<Record<SkillId, SkillState>>;
  bornAt: WorldTime;
  massKg: number;
  patchId: PatchId;
  /**
   * The outside agent steering this animal, if any (docs/2026-09-26-live-agents-design.md).
   * Its body still ages, hungers and can die in the hourly step; where it goes and what it
   * does come from the live layer. Absent for every wild animal.
   */
  controller?: string;
  /** Optional only for legacy snapshots; initialized deterministically by the simulation. */
  position?: WorldPosition;
  /** Authoritative non-ground travel state. Absent on old/ground-only checkpoints. */
  altitudeM?: number;
  /** Congo 1B: while `locomotionMode` is 'submerged', the world time it surfaces. */
  submergedUntil?: number;
  locomotionMode?: LocomotionMode;
  /** Stable shared trunk identity while an arboreal animal is above ground. */
  treeAnchorId?: string;
  /** Prevent contradictory second actions for a prey animal in the same coarse decision tick. */
  lastEncounterAt?: WorldTime;
  state: AgentState;
  currentGoal: GoalId;
  alternativeGoal: GoalId | null;
  goalScore: number;
  drives: Drives;
  alive: boolean;
  /** World time it died or left the forest. Absent while it is here. */
  departedAt?: number;
}
