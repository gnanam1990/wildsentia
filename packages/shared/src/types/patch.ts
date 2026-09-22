export const GRID_SIZE = 20;
export const PATCH_METRES = 300;
export const PATCH_COUNT = GRID_SIZE * GRID_SIZE;
export const NUTRIENT_PER_KG_BIOMASS = 0.02;

export type HabitatType = 'shola' | 'grassland' | 'riparian' | 'rock' | 'marsh' | 'water';
export type PatchId = number;

export interface PlantBiomass {
  grass: number;
  browse: number;
}

export interface Patch {
  id: PatchId;
  x: number;
  y: number;
  elevation: number;
  habitat: HabitatType;
  canopyCover: number;
  plant: PlantBiomass;
  capacity: PlantBiomass;
  soilMoisture: number;
  soilNutrients: number;
  waterVolume: number;
  neighbours: PatchId[];
}
