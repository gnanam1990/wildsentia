import type { WorldEvent, WorldPosition } from '@vana/shared';

/** One young starvation/dehydration death whose parent was still alive when it died. */
export interface YoungDeprivationRecord {
  worldTime: number; species: string; cause: string; lifeStage: string; ageDays: number;
  childId: string; parentId: string | null; patchId: number; parentPatchId: number | null;
  /** Child carcass to parent, measured at the end of the simulated hour the death fell in. */
  parentDistanceM: number | null; careRadiusM: number;
  /** `remote` = parent beyond the care-contact radius at the end of that hour. */
  contact: 'near' | 'remote' | 'unknown';
}

/** Tallies for one world-year window. Each count is accumulated from authoritative events. */
export interface SoakYear {
  year: number; startDay: number; endDay: number;
  /** Living count per species at the end of the window. */
  population: Record<string, number>;
  births: Record<string, number>;
  /** `species/cause` and `species` totals. */
  deaths: Record<string, number>;
  deathsByCause: Record<string, number>;
  /** `species/cause/careState` for starvation and dehydration deaths. */
  deprivation: Record<string, number>;
  /** Unweaned starvation/dehydration while a parent was alive, split by contact. */
  youngDeprivationWithParent: { near: number; remote: number; unknown: number };
  /** Starvation/dehydration of weaned juveniles and subadults (no care entitlement left). */
  weanedYoungDeprivation: number;
  extinct: string[];
  nutrientDrift: number;
  /** Grazeable land's standing grass+browse as a percent of capacity: year end and daily low. */
  forage: { endPct: number; minPct: number; minDay: number };
}

export function emptySoakYear(year: number, startDay: number): SoakYear {
  return { year, startDay, endDay: startDay, population: {}, births: {}, deaths: {}, deathsByCause: {},
    deprivation: {}, youngDeprivationWithParent: { near: 0, remote: 0, unknown: 0 },
    weanedYoungDeprivation: 0, extinct: [], nutrientDrift: 0, forage: { endPct: NaN, minPct: Infinity, minDay: startDay } };
}

const bump = (tally: Record<string, number>, key: string): void => { tally[key] = (tally[key] ?? 0) + 1; };

export interface ParentLookup {
  /** Who the dead animal depended on, from its saved record. */
  dependentOn(childId: string): string | null;
  /** Current location of a living parent, or null if none. */
  locate(parentId: string): { patchId: number; position: WorldPosition } | null;
  careRadiusM(species: string): number;
}

const YOUNG_STAGES = new Set(['newborn', 'juvenile', 'subadult']);

/** Fold one event into the current year. Returns a with-parent record when the event is one. */
export function recordYearEvent(year: SoakYear, event: WorldEvent, parents: ParentLookup): YoungDeprivationRecord | null {
  if (event.type === 'born') {
    bump(year.births, String(event.conditions.species ?? '?'));
    return null;
  }
  if (event.type !== 'died') return null;
  const species = String(event.conditions.species ?? event.actors[0]?.split('_')[0] ?? 'unknown');
  const cause = String(event.conditions.cause ?? 'unknown');
  bump(year.deaths, species); bump(year.deaths, `${species}/${cause}`); bump(year.deathsByCause, cause);
  if (cause !== 'starvation' && cause !== 'dehydration') return null;
  const careState = String(event.conditions.careState ?? 'unknown');
  bump(year.deprivation, `${species}/${cause}/${careState}`);
  const lifeStage = String(event.conditions.lifeStage ?? 'unknown');
  if (careState === 'weaned' && YOUNG_STAGES.has(lifeStage)) year.weanedYoungDeprivation++;
  if (careState !== 'unweaned_with_parent') return null;
  const childId = event.actors[0]!;
  const parentId = parents.dependentOn(childId);
  const parent = parentId ? parents.locate(parentId) : null;
  const radius = parents.careRadiusM(species);
  const distance = parent && event.position
    ? Math.hypot(parent.position.x - event.position.x, parent.position.z - event.position.z) : null;
  const contact = distance === null ? 'unknown' : distance <= radius + 1e-8 ? 'near' : 'remote';
  year.youngDeprivationWithParent[contact]++;
  return { worldTime: event.worldTime, species, cause, lifeStage, ageDays: Number(event.conditions.ageDays ?? NaN),
    childId, parentId, patchId: event.patchId, parentPatchId: parent?.patchId ?? null,
    parentDistanceM: distance, careRadiusM: radius, contact };
}

/** Standing grass+browse on grazeable land, as a percent of its capacity. */
export function foragePercent(patches: ReadonlyArray<{ plant: { grass: number; browse: number };
  capacity: { grass: number; browse: number } }>): number {
  let standing = 0, capacity = 0;
  for (const p of patches) { standing += p.plant.grass + p.plant.browse; capacity += p.capacity.grass + p.capacity.browse; }
  return capacity > 0 ? 100 * standing / capacity : 0;
}

/** Fold one daily forage sample into the year's low. */
export function sampleYearForage(year: SoakYear, day: number, percent: number): void {
  if (percent < year.forage.minPct) year.forage = { ...year.forage, minPct: percent, minDay: day };
}
