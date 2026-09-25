import { GRID_SIZE, type Patch, type Season, type WaterBudget } from '@vana/shared';
import { updateWater, waterRetentionL } from './water.js';

export const surfaceWaterL = (patches: readonly Patch[]): number => patches.reduce((sum, p) => sum + p.waterVolume, 0);
export function newWaterBudget(patches: readonly Patch[], sinceWorldTime: number): WaterBudget {
  return { sinceWorldTime, initialL: surfaceWaterL(patches), rainfallL: 0, groundwaterL: 0,
    evaporatedL: 0, boundaryOutflowL: 0, animalConsumptionL: 0 };
}
export function waterBudgetResidual(patches: readonly Patch[], budget: WaterBudget): number {
  return budget.initialL + budget.rainfallL + budget.groundwaterL - budget.evaporatedL
    - budget.boundaryOutflowL - budget.animalConsumptionL - (budget.communityWithdrawalL ?? 0) - surfaceWaterL(patches);
}

/** Strictly downhill cardinal drainage: deterministic, acyclic and independent of storage order.
 * Flat/interior sinks retain water. Boundary export is to the surrounding landscape, not a
 * fabricated ocean. This is a coarse catchment model, not river-bed geometry or hydraulic flow. */
export function drainageGraph(patches: readonly Patch[]): Map<number, number | null> {
  const byId = new Map(patches.map(p => [p.id, p]));
  if (byId.size !== patches.length || patches.some(p => !Number.isInteger(p.id) || p.id < 0
    || p.id >= GRID_SIZE * GRID_SIZE || !Number.isFinite(p.elevation)
    || !Number.isFinite(p.waterVolume) || p.waterVolume < 0 || (p.surface === 'ocean' && p.waterVolume !== 0))) throw new Error('invalid drainage patches');
  return new Map(patches.map(p => {
    if (p.surface === 'ocean' || (p.surface === 'coast' && p.elevation === 0)) return [p.id, null];
    const lower = p.neighbours.map(id => byId.get(id)).filter((n): n is Patch => !!n
      && Math.abs(n.id % GRID_SIZE - p.id % GRID_SIZE) + Math.abs(Math.floor(n.id / GRID_SIZE) - Math.floor(p.id / GRID_SIZE)) === 1
      && n.elevation < p.elevation).sort((a, b) => a.elevation - b.elevation || a.id - b.id);
    return [p.id, lower[0]?.id ?? null];
  }));
}

export function updateDrainage(patches: Patch[], hours: number, season: Season, budget: WaterBudget): void {
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('invalid drainage duration');
  const graph = drainageGraph(patches), byId = new Map(patches.map(p => [p.id, p]));
  for (const p of patches) {
    const flux = updateWater(p, hours, season);
    budget.rainfallL += flux.rainfallL; budget.groundwaterL += flux.groundwaterL; budget.evaporatedL += flux.evaporatedL;
    const x = p.id % GRID_SIZE, y = Math.floor(p.id / GRID_SIZE);
    const downstreamPatchId = graph.get(p.id)!;
    p.drainage = { downstreamPatchId, boundaryOutlet: downstreamPatchId === null
      && (x === 0 || y === 0 || x === GRID_SIZE - 1 || y === GRID_SIZE - 1 || p.surface === 'coast' && p.elevation === 0),
      inflowL: 0, outflowL: 0, hours };
  }
  // High-to-low routing is a quasi-steady solve for this decision. Water may traverse several
  // reaches in one step; no travel speed or physically simulated flood front is implied.
  for (const p of [...patches].sort((a, b) => b.elevation - a.elevation || a.id - b.id)) {
    const flow = p.drainage!, downstream = flow.downstreamPatchId === null ? undefined : byId.get(flow.downstreamPatchId);
    if (!downstream && !flow.boundaryOutlet) continue;
    const litres = Math.max(0, p.waterVolume - waterRetentionL(p));
    p.waterVolume -= litres; flow.outflowL = litres;
    if (downstream?.surface === 'ocean') {
      flow.boundaryOutlet = true; budget.boundaryOutflowL += litres;
    } else if (downstream) { downstream.waterVolume += litres; downstream.drainage!.inflowL += litres; }
    else budget.boundaryOutflowL += litres;
  }
}
