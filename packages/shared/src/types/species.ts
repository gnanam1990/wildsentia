import type { HabitatType } from './patch.js';

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
  };
  lifecycle: { maxAgeDays: number; baselineMortalityPerDay: number };
}
