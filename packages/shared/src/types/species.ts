import type { HabitatType } from './patch.js';
import type { LifeStage } from './agent.js';

export type Archetype =
  | 'apex_predator' | 'pack_predator' | 'herd_grazer'
  | 'mega_herbivore' | 'omnivore_rooter' | 'arboreal_troop' | 'scavenger_flyer';

export type TrophicRole =
  | 'apex_predator' | 'mesopredator' | 'grazer' | 'browser' | 'omnivore' | 'scavenger';

export interface SpeciesConfig {
  id: string;
  displayName: string;
  archetype: Archetype;
  trophicRole: TrophicRole[];
  body: { adultMassKg: number; shoulderHeightM: number };
  locomotion: {
    walkMs: number;
    trotMs: number;
    sprintMs: number;
    sprintStaminaS: number;
    terrainCost: Record<HabitatType, number>;
  };
  senses: { sightRangeM: number; hearingRangeM: number; smellRangeM: number };
  escape: { detectionDistanceM: number; flightInitiationM: number; evasiveness: number };
  diet: {
    eats: Array<{ target: 'grass' | 'browse' | 'meat'; preference: number }>;
    dailyIntakeKg: number;
    waterNeedLPerDay: number;
    canScavenge: boolean;
    /** 0-1 resistance to the pathogens a carcass carries. Vultures are near 1; jackals are not. */
    carrionTolerance: number;
  };
  hunting?: {
    preferredPrey: string[];
    /** How well this predator hides while approaching, before terrain is considered. */
    stalkConcealment: number;
    commitDistanceM: number;
    /** Success against an unaware, healthy adult in the open, before every modifier. */
    baseSuccess: number;
    staminaCostPerChase: number;
  };
  social: {
    structure: 'solitary' | 'pair' | 'herd' | 'troop' | 'pack' | 'family';
    groupSize: [min: number, max: number];
    alarmSharing: boolean;
  };
  lifecycle: {
    maxAgeDays: number;
    baselineMortalityPerDay: number;
    stages: Array<{
      name: LifeStage;
      startDays: number;
      /** Fraction of adult mass at the start of this stage. */
      sizeFactor: number;
      dependent: boolean;
      mortalityPerDay: number;
    }>;
    sexualMaturityDays: number;
    gestationDays: number;
    litterSize: [min: number, max: number];
    interBirthIntervalDays: number;
    weanDays: number;
    dispersalDays: number;
  };
}
