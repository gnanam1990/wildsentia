export const NUTRIENT_PER_KG_BIOMASS = 0.02;

export type IslandHabitat = 'shola' | 'grassland' | 'riparian' | 'rock' | 'marsh' | 'water';
/** The Congo forest's own habitats (congo_terrain_v1). Its river channels are `water`. */
export type CongoHabitat = 'terra_firme' | 'flooded_forest' | 'swamp_forest' | 'bai';
export type HabitatType = IslandHabitat | CongoHabitat;

export const ISLAND_HABITATS: readonly IslandHabitat[] = ['shola', 'grassland', 'riparian', 'rock', 'marsh', 'water'];
export const CONGO_HABITATS: readonly CongoHabitat[] = ['terra_firme', 'flooded_forest', 'swamp_forest', 'bai'];
/**
 * The island habitat each Congo habitat behaves like wherever a table has no Congo entry of its
 * own: dry closed forest as shola, seasonally flooded forest as riparian, swamp forest as marsh,
 * an open bai as grassland.
 */
export const HABITAT_ANALOGUE: Readonly<Record<CongoHabitat, IslandHabitat>> = {
  terra_firme: 'shola', flooded_forest: 'riparian', swamp_forest: 'marsh', bai: 'grassland',
};
/** The island habitat a patch looks and behaves like where only island figures exist. */
export const habitatAnalogue = (habitat: string): IslandHabitat =>
  (HABITAT_ANALOGUE as Partial<Record<string, IslandHabitat>>)[habitat] ?? habitat as IslandHabitat;
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
  /** Congo worlds only: the seed of their congo_terrain_v1 geometry. */
  congoSeed?: number;
  /** Congo 1B: flooded forest under the season's flood (set each hour by the world); absent elsewhere. */
  flooded?: boolean;
  /** Congo 1B: the deep middle of the great river (no dry ground beside it): no land animal walks it. */
  deepWater?: boolean;
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
