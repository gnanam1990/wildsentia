export const NUTRIENT_PER_KG_BIOMASS = 0.02;

export type HabitatType = 'shola' | 'grassland' | 'riparian' | 'rock' | 'marsh' | 'water';
export type PatchId = number;

export interface PlantBiomass {
  grass: number;
  browse: number;
}

/** One anonymous insect-visited understorey guild. Biomass is kilograms, not plant counts. */
export interface FloweringGuildState {
  guildId: 'insect_visited_understorey_v1';
  capacityKg: number;
  vegetativeKg: number;
  lastBloomYear: number;
  bloom?: {
    openedAt: number;
    closesAt: number;
    maturesAt: number;
    openKg: number;
    visitedKg: number;
    closed: boolean;
  };
  seedBank: Array<{ biomassKg: number; maturedAt: number; germinateAt: number; expiresAt: number }>;
}

export interface Patch {
  id: PatchId;
  x: number;
  y: number;
  elevation: number;
  /** Absent on legacy mainland worlds. Island geometry and mask share the versioned seed. */
  islandSeed?: number;
  surface?: 'land' | 'coast' | 'ocean';
  habitat: HabitatType;
  canopyCover: number;
  plant: PlantBiomass;
  capacity: PlantBiomass;
  /**
   * sim_0.37.0: the finite rooting and mast food of a land patch: underground storage organs,
   * soil invertebrates, fallen fruit and seed, which wild boar dig and pick up. It regrows from
   * the soil's nutrients like the plants above it, and boar deplete it. Absent off land and on
   * pre-0.37 checkpoints until an explicit upgrade establishes it.
   */
  rooting?: { kg: number; capacityKg: number };
  /** Reserved out of generic browse at world founding or an explicit rules upgrade. */
  floweringGuild?: FloweringGuildState;
  soilMoisture: number;
  soilNutrients: number;
  waterVolume: number;
  /** Last completed hydrology step; null destination is an interior basin or boundary outlet. */
  drainage?: { downstreamPatchId: PatchId | null; boundaryOutlet: boolean; inflowL: number; outflowL: number; hours: number };
  neighbours: PatchId[];
}

/** Surface freshwater accounting only. Groundwater is an explicit external supply; soil moisture is a proxy. */
export interface WaterBudget {
  sinceWorldTime: number;
  initialL: number;
  rainfallL: number;
  groundwaterL: number;
  evaporatedL: number;
  boundaryOutflowL: number;
  animalConsumptionL: number;
  /** Surface water removed into community containers, including later consumption. */
  communityWithdrawalL?: number;
}
