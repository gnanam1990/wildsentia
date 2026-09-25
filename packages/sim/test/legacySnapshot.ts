import type { Snapshot } from '../src/snapshot.js';
import type { Patch } from '@vana/shared';

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

/** Reconstruct the pre-v0.28 plant ledger for migration fixtures. Merely changing
 * simVersion on a new checkpoint would smuggle future flowering state into old rules. */
export function asLegacySnapshot(snapshot: Snapshot, simVersion: string): Snapshot {
  const old = structuredClone(snapshot);
  old.simVersion = simVersion;
  stripFloweringGuild(old.patches);
  return old;
}
