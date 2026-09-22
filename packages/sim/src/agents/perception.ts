import type { Agent, Carcass, Patch, SpeciesConfig } from '@vana/shared';

/** What the behaviour layer is allowed to ask the world. Agents never read global state. */
export interface WorldView {
  patches: Patch[];
  agentsInPatch(patchId: number): readonly Agent[];
  carcassesInPatch(patchId: number): readonly Carcass[];
  speciesOf(speciesId: string): SpeciesConfig;
}

export interface Percept {
  patch: Patch;
  neighbours: Patch[];
  bestFood: { patchId: number; kg: number } | null;
  bestWater: { patchId: number; litres: number } | null;
  /** Prey this predator would actually pursue, in the patch it can reach. */
  prey: Array<{ agent: Agent; patchId: number; herdSize: number }>;
  carrion: { carcass: Carcass; patchId: number } | null;
  /** A predator close enough to matter. Drives fear and flight. */
  threat: { agent: Agent; patchId: number } | null;
  herdSize: number;
}

const edibleKg = (patch: Patch, species: SpeciesConfig): number => {
  let kg = 0;
  for (const item of species.diet.eats) {
    if (item.target === 'grass') kg += patch.plant.grass * item.preference;
    if (item.target === 'browse') kg += patch.plant.browse * item.preference;
  }
  return kg;
};

const isPredator = (config: SpeciesConfig): boolean =>
  config.archetype === 'apex_predator' || config.archetype === 'pack_predator';

/**
 * Agents see their own patch and its immediate neighbours, never the whole world. Everything
 * downstream — goal scores, hunts, flight — is computed from this limited view.
 */
export function perceive(agent: Agent, species: SpeciesConfig, view: WorldView): Percept {
  const patch = view.patches[agent.patchId]!;
  const neighbours = patch.neighbours.map((id) => view.patches[id]!);
  const visible = [patch, ...neighbours];

  let bestFood: Percept['bestFood'] = null;
  let bestWater: Percept['bestWater'] = null;
  let carrion: Percept['carrion'] = null;
  let threat: Percept['threat'] = null;
  const prey: Percept['prey'] = [];

  const wantsMeat = species.hunting !== undefined;
  const preferred = new Set(species.hunting?.preferredPrey ?? []);

  for (const p of visible) {
    const kg = edibleKg(p, species);
    if (kg > 0 && (bestFood === null || kg > bestFood.kg)) bestFood = { patchId: p.id, kg };
    if (p.waterVolume > 0 && (bestWater === null || p.waterVolume > bestWater.litres)) {
      bestWater = { patchId: p.id, litres: p.waterVolume };
    }

    if (species.diet.canScavenge && carrion === null) {
      const found = view.carcassesInPatch(p.id)[0];
      if (found !== undefined) carrion = { carcass: found, patchId: p.id };
    }

    const occupants = view.agentsInPatch(p.id);

    if (wantsMeat) {
      const bySpecies = new Map<string, number>();
      for (const other of occupants) {
        if (!other.alive) continue;
        bySpecies.set(other.speciesId, (bySpecies.get(other.speciesId) ?? 0) + 1);
      }
      for (const other of occupants) {
        if (!other.alive || other.id === agent.id || !preferred.has(other.speciesId)) continue;
        prey.push({ agent: other, patchId: p.id, herdSize: bySpecies.get(other.speciesId) ?? 1 });
      }
    }

    if (threat === null && p.id === agent.patchId) {
      for (const other of occupants) {
        if (!other.alive || other.id === agent.id) continue;
        const otherSpecies = view.speciesOf(other.speciesId);
        if (!isPredator(otherSpecies)) continue;
        if (!(otherSpecies.hunting?.preferredPrey ?? []).includes(agent.speciesId)) continue;
        threat = { agent: other, patchId: p.id };
        break;
      }
    }
  }

  const herdSize = view
    .agentsInPatch(agent.patchId)
    .reduce((n, other) => n + (other.alive && other.speciesId === agent.speciesId ? 1 : 0), 0);

  return { patch, neighbours, bestFood, bestWater, prey, carrion, threat, herdSize };
}
