import {
  NUTRIENT_PER_KG_BIOMASS, carcassMass,
  type Agent, type Carcass, type Patch,
  type MicroEcologyState,
} from '@vana/shared';
import { microBiomassKg, communityBiomassKg, type CommunityState } from '@vana/shared';

export interface NutrientLedger {
  /** Nutrients that entered the world with immigrants. Subtracted so arrivals are not creation. */
  imported: number;
  /** Nutrients that left with emigrants. Added back so departures are not destruction. */
  exported: number;
}

export function totalNutrients(
  patches: Patch[],
  agents: Agent[],
  ledger: NutrientLedger,
  carcasses: readonly Carcass[] = [],
  microEcology?: MicroEcologyState,
  community?: CommunityState | null,
): number {
  let total = 0;
  for (const p of patches) {
    total += p.soilNutrients + (p.plant.grass + p.plant.browse) * NUTRIENT_PER_KG_BIOMASS;
    const guild = p.floweringGuild;
    if (guild) total += (guild.vegetativeKg + (guild.bloom?.openKg ?? 0)
      + (guild.bloom?.visitedKg ?? 0)
      + guild.seedBank.reduce((sum, seed) => sum + seed.biomassKg, 0)) * NUTRIENT_PER_KG_BIOMASS;
  }
  for (const a of agents) {
    if (a.alive) total += (a.massKg + (a.packFood?.kg ?? 0)) * NUTRIENT_PER_KG_BIOMASS;
  }
  // A dead animal's mass sits in its carcass until scavengers and decay move it into the soil.
  for (const c of carcasses) {
    total += carcassMass(c.biomass) * NUTRIENT_PER_KG_BIOMASS;
  }
  if (microEcology) total += microBiomassKg(microEcology) * NUTRIENT_PER_KG_BIOMASS;
  total += communityBiomassKg(community) * NUTRIENT_PER_KG_BIOMASS;
  return total - ledger.imported + ledger.exported;
}

export function assertNutrientsConserved(baseline: number, actual: number, tolerance = 1e-3): void {
  const drift = Math.abs(actual - baseline);
  if (drift > tolerance) {
    throw new Error(
      `nutrient conservation violated: baseline=${baseline} actual=${actual} drift=${drift} tolerance=${tolerance}`,
    );
  }
}
