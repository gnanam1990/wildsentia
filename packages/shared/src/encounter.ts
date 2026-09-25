import type { WorldPosition } from './spatial.js';
import type { LiveMovement } from './movement.js';
import type { LifeStage, Sex } from './types/agent.js';

export type EncounterPhase = 'approach' | 'stalk' | 'chase' | 'contact' | 'escape' | 'abandon';
export interface EncounterSample {
  seconds: number;
  phase: EncounterPhase;
  predator: WorldPosition;
  prey: WorldPosition;
}

/** Recorded by the simulation, never synthesized by narration or a viewer. */
export interface EncounterTrace {
  version: 1;
  predatorId: string;
  preyId: string;
  startWorldTime: number;
  patchId: number;
  contactRadiusM: number;
  samples: EncounterSample[];
}

/** Appearance at the start of the recorded hour, including prey no longer in the live set. */
export interface EncounterAppearance {
  id: string;
  speciesId: string;
  sizeRatio: number;
  coatVariant: number;
  /** Added to new recordings; optional so older checkpointed hours still load. */
  sex?: Sex;
  lifeStage?: LifeStage;
}

export interface LiveEncounter {
  eventId: string;
  outcome: 'success' | 'failure' | 'abandoned' | 'interrupted';
  predatorSpecies: string;
  preySpecies: string;
  predator: EncounterAppearance;
  prey: EncounterAppearance;
  trace: EncounterTrace;
}

/** Last checkpointed hour, played one hour behind authoritative state. No client commands. */
export interface LiveEncounterFrame {
  id: string;
  startWorldTime: number;
  endWorldTime: number;
  rate: number;
  elapsedWorldSeconds: number;
  encounters: LiveEncounter[];
  /** Optional for old servers. Disjoint ordinary routes, using this same checkpoint clock. */
  movements?: LiveMovement[];
}
