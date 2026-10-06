import type { Snapshot } from '../src/snapshot.js';
import { NUTRIENT_PER_KG_BIOMASS, type Patch } from '@vana/shared';

export function stripFloweringGuild(patches: Patch[]): void {
  for (const patch of patches) {
    const guild = patch.floweringGuild;
    if (!guild) continue;
    if (guild.bloom || guild.seedBank.length)
      throw new Error('cannot synthesize an old checkpoint from a flowering world');
    patch.plant.browse += guild.vegetativeKg;
    patch.capacity.browse += guild.capacityKg;
    delete patch.floweringGuild;
  }
}

/** sim_0.37.0 state no older checkpoint carries: rooting food (returned to the soil it came
 * from), body condition and the daily gut tally. */
export function stripV37State(snapshot: Snapshot): void {
  for (const patch of snapshot.patches) {
    if (!patch.rooting) continue;
    patch.soilNutrients += patch.rooting.kg * NUTRIENT_PER_KG_BIOMASS;
    delete patch.rooting;
  }
  for (const agent of [...snapshot.agents, ...snapshot.deceased]) { delete agent.condition; delete agent.gutFill; }
  for (const carcass of snapshot.carcasses) delete carcass.cachedBy;
  delete snapshot.pendingArrivals;
}

/** Reconstruct the pre-v0.28 plant ledger for migration fixtures. Merely changing
 * simVersion on a new checkpoint would smuggle future flowering state into old rules. */
export function asLegacySnapshot(snapshot: Snapshot, simVersion: string): Snapshot {
  const old = structuredClone(snapshot);
  old.simVersion = simVersion;
  stripFloweringGuild(old.patches);
  stripV37State(old);
  return old;
}
