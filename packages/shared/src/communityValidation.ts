import { ISLAND_GRID, isWorldPosition as isGridPosition, patchAtPosition as gridPatchAt, patchCentre as gridCentre,
  positionInPatch as gridPositionInPatch, type WorldPosition } from './grid.js';

// A community exists only on the island profiles, whose lattice is always the island grid.
const positionInPatch = (value: unknown, patchId: number): value is WorldPosition => gridPositionInPatch(ISLAND_GRID, value, patchId);
const isWorldPosition = (value: unknown): value is WorldPosition => isGridPosition(ISLAND_GRID, value);
const patchAtPosition = (value: Parameters<typeof gridPatchAt>[1]): number => gridPatchAt(ISLAND_GRID, value);
const patchCentre = (id: number): { x: number; z: number } => gridCentre(ISLAND_GRID, id);
const PATCH_METRES = ISLAND_GRID.patchM;
import { HOME_STAGES, HOME_SHELTER_THRESHOLD, type CommunityState } from './types/community.js';
import { isCommunityMotion } from './communityMotion.js';

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const number = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const legacyActions = ['gather_food', 'collect_water', 'gather_timber', 'gather_fibre', 'deliver', 'eat', 'drink', 'sleep', 'build', 'rest'];
const inventory = (v: unknown, version: number) => record(v) && ['foodKg', 'timberKg', 'fibreKg', 'waterL'].every(k => number(v[k], 1e6))
  && (version >= 2 ? number(v.rawFishKg, 1e6) : v.rawFishKg === undefined)
  && (version >= 6 ? number(v.rawMeatKg, 1e6) : v.rawMeatKg === undefined);
const unitFields = (v: unknown, keys: string[]) => record(v) && keys.every(k => number(v[k], 1));

/** Bounded persisted/public contract. Unknown future versions fail closed. */
export function isCommunityState(value: unknown): value is CommunityState {
  if (!record(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4 && value.version !== 5 && value.version !== 6 && value.version !== 7 && value.version !== 8) || value.profile !== 'household_v1'
    || !text(value.id) || !text(value.name) || !text(value.householdId)
    || !number(value.foundedAt) || !number(value.updatedAt) || value.foundedAt > value.updatedAt
    || !number(value.patchId, 399) || !Number.isInteger(value.patchId)
    || !inventory(value.stores, value.version) || !Array.isArray(value.people)
    || (value.version >= 7 ? value.people.length < 4 || value.people.length > 12
      || value.nextPersonSeq !== value.people.length + 1 : value.people.length !== 4 || value.nextPersonSeq !== undefined)) return false;
  const actions = value.version >= 2 ? [...legacyActions, 'fish', 'cook'] : legacyActions;
  if (value.version >= 4) actions.push('repair');
  if (value.version >= 5) actions.push('seek_resources');
  if (value.version >= 6) actions.push('hunt');
  if (value.version >= 7) actions.push('care_child');
  const state = value, at = value.updatedAt, patchId = value.patchId;
  const b = value.building;
  if (!record(b) || !text(b.id) || !positionInPatch(b.position, patchId)
    || !['site', 'frame', 'walls', 'roof', 'occupied'].includes(String(b.stage))
    || !number(b.labourSeconds, 43_200) || !record(b.materials)
    || !number(b.materials.timberKg, 96) || !number(b.materials.fibreKg, 72)
    || !(b.completedAt === null || number(b.completedAt, at)) || !Array.isArray(b.occupantIds)
    || b.occupantIds.length > value.people.length || new Set(b.occupantIds).size !== b.occupantIds.length) return false;
  const index = b.stage === 'occupied' ? 4 : HOME_STAGES.findIndex(s => s.from === b.stage);
  const materials = HOME_STAGES.slice(0, index).reduce((s, step) => ({ timber: s.timber + step.timberKg, fibre: s.fibre + step.fibreKg }), { timber: 0, fibre: 0 });
  const wornHome = value.version >= 4 && b.stage === 'occupied';
  if ((!wornHome && (b.materials.timberKg !== materials.timber || b.materials.fibreKg !== materials.fibre))
    || (b.stage === 'occupied') !== (b.completedAt !== null)
    || (b.stage !== 'occupied' && b.occupantIds.length !== 0)
    || (b.stage === 'occupied' ? b.labourSeconds !== 0 : b.labourSeconds >= HOME_STAGES[index]!.labourSeconds)) return false;
  if (value.version >= 4) {
    const m = b.maintenance;
    if (!record(m) || !number(m.repairsCompleted) || !Number.isSafeInteger(m.repairsCompleted)
      || !(m.lastRepairAt === null || number(m.lastRepairAt, at))
      || (m.repairsCompleted === 0) !== (m.lastRepairAt === null)
      || (m.repairsCompleted > 0 && (!number(m.lastRepairAt)
        || (value.version < 8 || m.collapses === 0) && (b.stage !== 'occupied' || !number(b.completedAt) || m.lastRepairAt < b.completedAt)))) return false;
    if (value.version >= 8) {
      if (!number(m.collapses) || !Number.isSafeInteger(m.collapses)
        || !number(m.rebuildsCompleted, m.collapses) || !Number.isSafeInteger(m.rebuildsCompleted)
        || !(m.lastCollapseAt === null || number(m.lastCollapseAt, at))
        || !(m.lastCollapseEventId === null || text(m.lastCollapseEventId))
        || (m.collapses === 0) !== (m.lastCollapseAt === null && m.lastCollapseEventId === null)
        || (m.collapses > 0 && (m.lastCollapseAt === null || m.lastCollapseEventId === null))
        || (b.stage === 'occupied' && m.rebuildsCompleted !== m.collapses)
        || (b.stage !== 'occupied' && m.collapses > 0 && m.rebuildsCompleted >= m.collapses)
        || (b.stage === 'occupied' && m.lastCollapseAt !== null && (!number(b.completedAt) || b.completedAt <= m.lastCollapseAt))) return false;
    } else if (m.collapses !== undefined || m.lastCollapseAt !== undefined
      || m.lastCollapseEventId !== undefined || m.rebuildsCompleted !== undefined) return false;
  } else if (b.maintenance !== undefined) return false;
  const ids = new Set<string>();
  const targetPeople: string[] = [];
  for (const p of value.people) {
    if (!record(p) || !text(p.id) || ids.has(p.id) || !text(p.name) || p.householdId !== state.householdId
      || !number(p.appearanceSeed, 0xffffffff) || !Number.isInteger(p.appearanceSeed)
      || !number(p.ageDays) || !number(p.massKg, 250) || !number(p.health, 1)
      || typeof p.alive !== 'boolean' || !(p.diedAt === null || number(p.diedAt, at))
      || p.alive !== (p.diedAt === null) || !number(p.patchId, 399) || !Number.isInteger(p.patchId)
      || (value.version < 5 && p.patchId !== patchId) || !positionInPatch(p.position, p.patchId)
      || !inventory(p.inventory, value.version) || !unitFields(p.needs, ['hunger', 'thirst', 'fatigue'])
      || !unitFields(p.skills, ['gathering', 'building'])
      || !record(p.skills) || (value.version >= 2 ? !number(p.skills.fishing, 1) : p.skills.fishing !== undefined)
      || (value.version >= 6 ? !number(p.skills.hunting, 1) : p.skills.hunting !== undefined)
      || !record(p.retryAfter) || !Object.entries(p.retryAfter).every(([k, v]) => actions.includes(k) && number(v))) return false;
    ids.add(p.id);
    if (value.version >= 7) {
      if (!number(p.bornAt, at) || !Number.isSafeInteger(p.generation) || !number(p.generation, 100)
        || !['gestational', 'non_gestational'].includes(String(p.reproductiveRole))
        || !(p.lastBirthAt === null || number(p.lastBirthAt, at))
        || (p.generation === 0 ? p.bornAt !== 0 || p.motherId !== null || p.fatherId !== null
          : !text(p.motherId) || !text(p.fatherId) || p.motherId === p.fatherId || p.bornAt === 0)
        || (p.reproductiveRole !== 'gestational' && (p.pregnancy !== null || p.lastBirthAt !== null))
        || (p.pregnancy !== null && (!p.alive || !record(p.pregnancy)
          || !text(p.pregnancy.fatherId) || !text(p.pregnancy.conceivedEventId)
          || !number(p.pregnancy.conceivedAt, at) || !number(p.pregnancy.dueAt)
          || p.pregnancy.dueAt <= p.pregnancy.conceivedAt || !number(p.pregnancy.fetusKg, 3.2)))) return false;
    } else if (p.bornAt !== undefined || p.motherId !== undefined || p.fatherId !== undefined
      || p.generation !== undefined || p.reproductiveRole !== undefined
      || p.lastBirthAt !== undefined || p.pregnancy !== undefined) return false;
    if (value.version >= 5) {
      if (!Array.isArray(p.visitedSites) || p.visitedSites.length > 400) return false;
      const seen = new Set<number>();
      for (const site of p.visitedSites) {
        if (!record(site) || !number(site.patchId, 399) || !Number.isInteger(site.patchId)
          || seen.has(site.patchId) || !number(site.at, at) || site.at < value.foundedAt) return false;
        seen.add(site.patchId);
      }
    } else if (p.visitedSites !== undefined) return false;
    if (p.task !== null) {
      const t = p.task;
      if (!p.alive || !record(t) || !actions.includes(String(t.kind)) || !['travel', 'work'].includes(String(t.phase))
        || !(value.version >= 5 ? isWorldPosition(t.destination) : positionInPatch(t.destination, patchId))
        || !number(t.remainingSeconds, 3600) || t.remainingSeconds === 0
        || !number(t.startedAt, at) || !text(t.eventId)) return false;
      if (value.version >= 5) {
        const j = t.journey;
        if (!record(j) || !number(j.destinationPatchId, 399) || !Number.isInteger(j.destinationPatchId)
          || !positionInPatch(t.destination, j.destinationPatchId) || !Array.isArray(j.waypoints) || j.waypoints.length > 401) return false;
        let previous = p.patchId;
        for (const point of j.waypoints) {
          if (!isWorldPosition(point)) return false;
          const next = patchAtPosition(point), a = patchCentre(previous), b = patchCentre(next);
          if (previous !== next && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== PATCH_METRES) return false;
          previous = next;
        }
        const last = j.waypoints.at(-1);
        if (t.phase === 'travel' ? !isWorldPosition(last) || last.x !== t.destination.x || last.z !== t.destination.z
          : j.waypoints.length !== 0 || p.patchId !== j.destinationPatchId
            || Math.hypot(p.position.x - t.destination.x, p.position.z - t.destination.z) > 1e-6) return false;
      } else if (t.journey !== undefined) return false;
      if ((value.version >= 6 && t.kind === 'hunt')
        ? !text(t.targetAgentId) : t.targetAgentId !== undefined) return false;
      if ((value.version >= 7 && t.kind === 'care_child')
        ? !text(t.targetPersonId) : t.targetPersonId !== undefined) return false;
      if (t.targetPersonId !== undefined) targetPeople.push(t.targetPersonId as string);
    }
  }
  const people = value.people;
  if (targetPeople.some(id => !ids.has(id)) || new Set(targetPeople).size !== targetPeople.length) return false;
  if (value.version >= 7) for (const p of people) {
    if (p.generation! > 0) {
      const mother = people.find(a => a.id === p.motherId), father = people.find(a => a.id === p.fatherId);
      if (!mother || !father || mother.reproductiveRole !== 'gestational'
        || father.reproductiveRole !== 'non_gestational' || mother.bornAt! >= p.bornAt! || father.bornAt! >= p.bornAt!
        || p.generation !== Math.max(mother.generation!, father.generation!) + 1) return false;
    }
    if (p.pregnancy !== null) {
      const father = people.find(a => a.id === p.pregnancy!.fatherId);
      if (!father || father.reproductiveRole !== 'non_gestational' || father.id === p.id
        || p.pregnancy!.conceivedAt < p.bornAt! || p.pregnancy!.dueAt <= at) return false;
    }
    if (p.task?.kind === 'care_child' && (p.ageDays < 6 * 360
      || !people.some(a => a.id === p.task!.targetPersonId && a.alive && a.ageDays < 6 * 360))) return false;
    if (p.ageDays < 6 * 360 && p.task !== null) return false;
  }
  if (value.version >= 3) {
    if (!Array.isArray(value.relationships) || value.relationships.length > (value.version >= 7 ? people.length * (people.length - 1) / 2 : 6)) return false;
    const pairs = new Set<string>();
    for (const r of value.relationships) {
      if (!record(r) || !Array.isArray(r.members) || r.members.length !== 2
        || !r.members.every(id => typeof id === 'string' && ids.has(id)) || r.members[0] >= r.members[1]
        || pairs.has(r.members.join(':')) || !number(r.sharedWorkSeconds, at - value.foundedAt)
        || !number(r.lastInteractionAt, at) || r.lastInteractionAt < value.foundedAt
        || !number(r.trust, 1) || Math.abs(r.trust - Math.min(1, r.sharedWorkSeconds / 144000)) > 1e-8
        || !number(r.reportedHours) || r.reportedHours !== Math.floor(r.sharedWorkSeconds / 3600)
        || !Array.isArray(r.lessons) || r.lessons.length > (value.version >= 7 ? 8 : 6)) return false;
      pairs.add(r.members.join(':'));
      const lessons = new Set<string>();
      for (const l of r.lessons) {
        if (!record(l) || !r.members.includes(l.learnerId) || !r.members.includes(l.teacherId) || l.learnerId === l.teacherId
          || !['gathering', 'building', 'fishing', ...(value.version >= 6 ? ['hunting'] : [])].includes(String(l.skill)) || !number(l.observedSeconds, r.sharedWorkSeconds)
          || !number(l.gain, 1) || !number(l.reportedGain, l.gain)) return false;
        const key = `${String(l.learnerId)}:${String(l.skill)}`;
        if (lessons.has(key)) return false; lessons.add(key);
      }
    }
  } else if (value.relationships !== undefined) return false;
  if (wornHome) {
    const habitable = Math.min(b.materials.timberKg / 96, b.materials.fibreKg / 72) >= HOME_SHELTER_THRESHOLD;
    const expected = habitable ? people.filter(p => p.alive).map(p => p.id) : [];
    const occupants = b.occupantIds;
    if (expected.length !== occupants.length || !expected.every(id => occupants.includes(id))) return false;
  }
  return b.occupantIds.every(id => people.some(p => p.id === id && p.alive))
    && (value.motion === undefined || isCommunityMotion(value.motion, value as unknown as CommunityState));
}
