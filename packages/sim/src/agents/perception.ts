import type { Agent, Patch, SpeciesConfig } from '@vana/shared';

export interface Percept {
  patch: Patch;
  neighbours: Patch[];
  bestFood: { patchId: number; kg: number } | null;
  bestWater: { patchId: number; litres: number } | null;
}

const edibleKg = (patch: Patch, species: SpeciesConfig): number => {
  let kg = 0;
  for (const item of species.diet.eats) {
    if (item.target === 'grass') kg += patch.plant.grass * item.preference;
    if (item.target === 'browse') kg += patch.plant.browse * item.preference;
  }
  return kg;
};

/** Agents see their own patch and its immediate neighbours. Never the whole world. */
export function perceive(agent: Agent, patches: Patch[], species: SpeciesConfig): Percept {
  const patch = patches[agent.patchId]!;
  const neighbours = patch.neighbours.map((id) => patches[id]!);
  const visible = [patch, ...neighbours];

  let bestFood: Percept['bestFood'] = null;
  let bestWater: Percept['bestWater'] = null;

  for (const p of visible) {
    const kg = edibleKg(p, species);
    if (kg > 0 && (bestFood === null || kg > bestFood.kg)) bestFood = { patchId: p.id, kg };
    if (p.waterVolume > 0 && (bestWater === null || p.waterVolume > bestWater.litres)) {
      bestWater = { patchId: p.id, litres: p.waterVolume };
    }
  }

  return { patch, neighbours, bestFood, bestWater };
}
