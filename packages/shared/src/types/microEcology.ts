import type { PatchId } from './patch.js';
import type { WorldTime } from '../time.js';

/** One local, unharvestable early-life cohort; not a count of individual fish. */
export interface FishCohort {
  stage: 'eggs' | 'larvae';
  biomassKg: number;
  spawnedAt: WorldTime;
  hatchAt: WorldTime;
  recruitAt: WorldTime;
}

/** Population-level organisms: individual persistence is reserved for notable animals. */
export interface MicroPatchPopulation {
  patchId: PatchId;
  antColonies: number;
  fishSchools: number;
  antBiomassKg: number;
  pollinatorBiomassKg: number;
  detritivoreBiomassKg: number;
  /** Finite freshwater primary-producer pool (algae/periphyton proxy), not fish biomass. */
  aquaticProducerBiomassKg: number;
  fishBiomassKg: number;
  /** Prevents repeated spawning in one simulated year. Zero means never spawned. */
  lastFishSpawnYear: number;
  fishCohort?: FishCohort;
  decomposerBiomassKg: number;
}

export interface MicroEcologyState {
  updatedAt: WorldTime;
  patches: MicroPatchPopulation[];
}

export function microBiomassKg(state: Pick<MicroEcologyState, 'patches'>): number {
  return state.patches.reduce((sum, p) => sum + p.antBiomassKg + p.pollinatorBiomassKg
    + p.detritivoreBiomassKg + p.aquaticProducerBiomassKg + p.fishBiomassKg
    + (p.fishCohort?.biomassKg ?? 0)
    + p.decomposerBiomassKg, 0);
}

/** Counts are presentation/observation projections, never hidden individual agents. */
export function microCounts(patch: MicroPatchPopulation): {
  ants: number; pollinators: number; detritivores: number; fish: number;
} {
  return {
    ants: Math.round(patch.antBiomassKg * 12_000),
    pollinators: Math.round(patch.pollinatorBiomassKg * 4_000),
    detritivores: Math.round(patch.detritivoreBiomassKg * 5_000),
    fish: Math.round(patch.fishBiomassKg * 10),
  };
}
