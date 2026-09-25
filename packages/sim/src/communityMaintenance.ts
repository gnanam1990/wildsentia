import { HOME_MATERIAL_CAPACITY, HOME_SHELTER_THRESHOLD, NUTRIENT_PER_KG_BIOMASS, homeCondition,
  seasonAt, spatialHash, type CommunityState, type Patch, type Person, type WaterBudget } from '@vana/shared';
import type { EventLog } from './events/log.js';
import { waterRetentionL } from './fields/water.js';

const DAY = 86400, HOUR = 3600, EPS = 1e-8;

function returnLostMaterial(state: CommunityState, patch: Patch, timberFraction: number, fibreFraction: number): { timberKg: number; fibreKg: number } {
  const material = state.building.materials;
  const lost = { timberKg: material.timberKg * timberFraction, fibreKg: material.fibreKg * fibreFraction };
  material.timberKg -= lost.timberKg; material.fibreKg -= lost.fibreKg;
  patch.soilNutrients += (lost.timberKg + lost.fibreKg) * NUTRIENT_PER_KG_BIOMASS;
  return lost;
}

/** Collapse salvages a finite share in shared stores and returns the rest to local soil. */
function collapseHome(state: CommunityState, patch: Patch, at: number, log: EventLog, cause: string, parentId: string,
  beforeHazard: number): void {
  const conditionAtFailure = homeCondition(state), material = state.building.materials;
  const salvage = { timberKg: material.timberKg * .25, fibreKg: material.fibreKg * .1 };
  const returned = material.timberKg + material.fibreKg - salvage.timberKg - salvage.fibreKg;
  state.stores.timberKg += salvage.timberKg; state.stores.fibreKg += salvage.fibreKg;
  patch.soilNutrients += returned * NUTRIENT_PER_KG_BIOMASS;
  material.timberKg = 0; material.fibreKg = 0;
  state.building.stage = 'site'; state.building.labourSeconds = 0;
  state.building.completedAt = null; state.building.occupantIds = [];
  const m = state.building.maintenance!; m.collapses = m.collapses! + 1; m.lastCollapseAt = at;
  const event = log.append({ type: 'building_collapsed', worldTime: Math.floor(at), simVersion: '', patchId: state.patchId,
    position: { ...state.building.position }, actors: [state.id, state.building.id], goal: 'shelter',
    conditions: { cause, conditionBefore: beforeHazard, conditionAtFailure }, effects: { salvagedTimberKg: salvage.timberKg,
      salvagedFibreKg: salvage.fibreKg, returnedKg: returned, collapses: m.collapses },
    outcome: 'success', causalParents: [parentId], confidence: 'authoritative' });
  m.lastCollapseEventId = event.id;
  updateShelter(state, beforeHazard, at, log, [event.id], 'collapse');
}

/** A version-pinned local storm adds real surface water; no renderer/viewer input is consulted. */
function localStorm(state: CommunityState, patch: Patch, seconds: number, at: number, log: EventLog, budget?: WaterBudget): void {
  if (state.version < 8) return;
  const boundary = Math.ceil(at / DAY) * DAY;
  if (boundary <= 0 || boundary >= at + seconds - EPS || boundary < at - EPS) return;
  const season = seasonAt(boundary);
  const frequency = season === 'monsoon' ? .09 : season === 'wet' ? .045 : season === 'transition' ? .02 : .005;
  const seed = `${patch.islandSeed ?? state.id}:${patch.id}:${Math.floor(boundary / DAY)}`;
  const roll = spatialHash(`${seed}:arrival`) / 0x1_0000_0000;
  if (roll >= frequency) return;
  if (!budget) throw new Error('v8 local storms require a water budget');
  const severity = spatialHash(`${seed}:strength`) / 0x1_0000_0000;
  const rainfallL = 2500 + severity * 4500;
  patch.waterVolume += rainfallL; budget.rainfallL += rainfallL;
  patch.soilMoisture = Math.min(1, patch.soilMoisture + rainfallL * .00004 * (1 - patch.soilMoisture));
  const before = homeCondition(state);
  const lost = state.building.stage === 'occupied'
    ? returnLostMaterial(state, patch, .04 + .11 * severity, .08 + .24 * severity)
    : { timberKg: 0, fibreKg: 0 };
  const event = log.append({ type: 'building_storm', worldTime: boundary, simVersion: '', patchId: state.patchId,
    position: { ...state.building.position }, actors: [state.id, state.building.id], goal: 'weather',
    conditions: { season, severity, rainfallL, roll, buildingStage: state.building.stage },
    effects: { timberLostKg: lost.timberKg, fibreLostKg: lost.fibreKg, condition: homeCondition(state) },
    outcome: 'success', causalParents: [], confidence: 'authoritative' });
  if (state.building.stage === 'occupied' && homeCondition(state) < .3) collapseHome(state, patch, boundary, log, 'storm', event.id, before);
  else updateShelter(state, before, boundary, log, [event.id], 'storm');
}

/** Flood load is sampled from the actual routed surface reservoir at an hourly boundary. */
function floodHome(state: CommunityState, patch: Patch, seconds: number, at: number, log: EventLog): void {
  if (state.version < 8 || state.building.stage !== 'occupied') return;
  const boundary = Math.ceil(at / HOUR) * HOUR;
  if (boundary >= at + seconds - EPS || boundary < at - EPS) return;
  const excessL = Math.max(0, patch.waterVolume - waterRetentionL(patch));
  if (excessL < 1200) return;
  const before = homeCondition(state), intensity = Math.min(1, excessL / 5000);
  const lost = returnLostMaterial(state, patch, .04 + .22 * intensity, .08 + .55 * intensity);
  const event = log.append({ type: 'building_flooded', worldTime: Math.floor(boundary), simVersion: '', patchId: state.patchId,
    position: { ...state.building.position }, actors: [state.id, state.building.id], goal: 'weather',
    conditions: { excessSurfaceWaterL: excessL, drainageInflowL: patch.drainage?.inflowL ?? 0, intensity },
    effects: { timberLostKg: lost.timberKg, fibreLostKg: lost.fibreKg, condition: homeCondition(state) },
    outcome: 'success', causalParents: [], confidence: 'authoritative' });
  if (homeCondition(state) < .3) collapseHome(state, patch, boundary, log, 'flood', event.id, before);
  else updateShelter(state, before, boundary, log, [event.id], 'flood');
}

/** Abstract pole/fibre decay parameters, not a claim about a real culture or building standard. */
export function weatherHome(state: CommunityState, patch: Patch, seconds: number, at: number, log: EventLog, budget?: WaterBudget): void {
  localStorm(state, patch, seconds, at, log, budget);
  floodHome(state, patch, seconds, at, log);
  if (state.version < 4 || state.building.stage !== 'occupied') return;
  const before = homeCondition(state), materials = state.building.materials;
  const dampness = 1 + Math.max(0, Math.min(1, patch.soilMoisture));
  for (const [key, days] of [['timberKg', 100], ['fibreKg', 45]] as const) {
    const lost = materials[key] * (1 - Math.exp(-seconds * dampness / (days * DAY)));
    materials[key] -= lost; patch.soilNutrients += lost * NUTRIENT_PER_KG_BIOMASS;
  }
  updateShelter(state, before, at, log);
}

export function homeRepairNeeds(state: CommunityState, person: Person): { timberKg: number; fibreKg: number } {
  if (state.version < 4 || state.building.stage !== 'occupied') return { timberKg: 0, fibreKg: 0 };
  const capacity = .5 + person.skills.building;
  return { timberKg: Math.min(Math.max(0, HOME_MATERIAL_CAPACITY.timberKg - state.building.materials.timberKg), 4 * capacity),
    fibreKg: Math.min(Math.max(0, HOME_MATERIAL_CAPACITY.fibreKg - state.building.materials.fibreKg), 6 * capacity) };
}

/** Commit after paid repair work. Shared materials are rechecked here, not reserved by a viewer. */
export function repairHome(state: CommunityState, person: Person, at: number, log: EventLog): { timberKg: number; fibreKg: number } {
  const need = homeRepairNeeds(state, person), before = homeCondition(state);
  if (state.version < 4 || before >= .99 || !person.alive || person.patchId !== state.patchId
    || person.task?.kind !== 'repair' || person.task.phase !== 'work' || person.task.remainingSeconds > 1e-8
    || Math.hypot(person.position.x - state.building.position.x, person.position.z - state.building.position.z) > 1)
    return { timberKg: 0, fibreKg: 0 };
  const used = { timberKg: Math.min(need.timberKg, state.stores.timberKg), fibreKg: Math.min(need.fibreKg, state.stores.fibreKg) };
  if (used.timberKg + used.fibreKg <= 1e-8) return { timberKg: 0, fibreKg: 0 };
  for (const key of ['timberKg', 'fibreKg'] as const) {
    state.stores[key] -= used[key]; state.building.materials[key] += used[key];
  }
  const m = state.building.maintenance!; m.repairsCompleted++; m.lastRepairAt = at;
  person.skills.building = Math.min(1, person.skills.building + .002);
  const parents = person.task ? [person.task.eventId] : [];
  log.append({ type: 'building_repaired', worldTime: Math.floor(at), simVersion: '', patchId: state.patchId,
    position: { ...state.building.position }, actors: [person.id, state.id, state.building.id], goal: 'repair',
    conditions: { method: 'local_material_replacement' }, effects: { ...used, conditionBefore: before,
      conditionAfter: homeCondition(state), repairsCompleted: m.repairsCompleted },
    outcome: 'success', causalParents: parents, confidence: 'authoritative' });
  updateShelter(state, before, at, log, parents);
  return used;
}

function updateShelter(state: CommunityState, before: number, at: number, log: EventLog, parents: string[] = [], reason = 'weathered'): void {
  const condition = homeCondition(state), available = condition >= HOME_SHELTER_THRESHOLD;
  state.building.occupantIds = available ? state.people.filter(p => p.alive).map(p => p.id) : [];
  if (available === (before >= HOME_SHELTER_THRESHOLD)) return;
  log.append({ type: 'building_shelter_changed', worldTime: Math.floor(at), simVersion: '', patchId: state.patchId,
    position: { ...state.building.position }, actors: [state.id, state.building.id], goal: 'shelter',
    conditions: { reason: available ? 'repaired' : reason, availability: available ? 'habitable' : 'uninhabitable' },
    effects: { condition, residents: state.building.occupantIds.length }, outcome: 'success', causalParents: parents, confidence: 'authoritative' });
}

export function sleepRecoveryFactor(state: CommunityState, person: Person): number {
  if (state.version < 4) return 1;
  const atHome = Math.hypot(person.position.x - state.building.position.x, person.position.z - state.building.position.z) <= 1;
  const quality = atHome && homeCondition(state) >= HOME_SHELTER_THRESHOLD ? homeCondition(state) : 0;
  return .5 + .5 * quality;
}
