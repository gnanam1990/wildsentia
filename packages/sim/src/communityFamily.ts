import { gridOfPatches,
  NUTRIENT_PER_KG_BIOMASS, emptyCommunityInventory, homeCondition, positionInPatch, spatialHash,
  type CommunityState, type Person, type Patch,
} from '@vana/shared';
import type { EventLog } from './events/log.js';

const DAY = 86_400;
const GESTATION_DAYS = 250; // Fictional world parameter, not a medical or cultural claim.
const MAX_PEOPLE = 12;
const CHILD_WORK_AGE_DAYS = 6 * 360;
const names = ['Aru', 'Luma', 'Sori', 'Navi', 'Taru', 'Ira', 'Omi', 'Sela'];
const distance = (a: Person, b: Person) => Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);

export function dependentChild(p: Person, version: number): boolean {
  return version >= 7 && p.ageDays < CHILD_WORK_AGE_DAYS;
}

export function closeKin(state: CommunityState, a: Person, b: Person): boolean {
  const byId = new Map(state.people.map(person => [person.id, person]));
  const ancestors = (person: Person): Set<string> => {
    const found = new Set<string>();
    const visit = (id: string | null | undefined, depth: number): void => {
      if (!id || depth > 3 || found.has(id)) return;
      found.add(id);
      const parent = byId.get(id);
      if (parent) { visit(parent.motherId, depth + 1); visit(parent.fatherId, depth + 1); }
    };
    visit(person.motherId, 1); visit(person.fatherId, 1);
    return found;
  };
  const aLine = ancestors(a), bLine = ancestors(b);
  return aLine.has(b.id) || bLine.has(a.id) || [...aLine].some(id => bLine.has(id));
}

function append(state: CommunityState, log: EventLog, type: 'human_conceived' | 'human_born' | 'human_pregnancy_lost',
  at: number, mother: Person, fatherId: string, effects: Record<string, number>, conditions: Record<string, string | number> = {}): void {
  log.append({ type, worldTime: Math.floor(at), simVersion: '', patchId: mother.patchId,
    position: { ...mother.position }, actors: type === 'human_born'
      ? [String(conditions.childId), mother.id, fatherId, state.id] : [mother.id, fatherId, state.id],
    conditions, outcome: 'success', effects,
    causalParents: mother.pregnancy?.conceivedEventId && type !== 'human_conceived' ? [mother.pregnancy.conceivedEventId] : [],
    confidence: 'authoritative' });
}

/** Pregnancy biomass is acquired only from actual meals; conception itself creates no mass. */
export function retainPrenatalFood(mother: Person, eatenKg: number): number {
  if (!mother.pregnancy || eatenKg <= 0) return 0;
  const retained = Math.min(eatenKg * .04, 3.2 - mother.pregnancy.fetusKg);
  mother.pregnancy.fetusKg += retained;
  return retained;
}

/** Called at paid minute boundaries. Conception requires adult health, a measured co-work edge,
 * local contact and a deterministic daily roll. Due pregnancies transfer real retained biomass
 * to a persistent child or return a failed pregnancy's matter to the mother's patch soil. */
export function advanceCommunityFamily(state: CommunityState, patches: Patch[], from: number, to: number, log: EventLog): void {
  if (state.version < 7) return;
  for (const mother of [...state.people]) {
    const pregnancy = mother.pregnancy;
    if (!pregnancy || (mother.alive && to < pregnancy.dueAt)) continue;
    if (!mother.alive || pregnancy.fetusKg < 2 || state.people.length >= MAX_PEOPLE) {
      patches[mother.patchId]!.soilNutrients += pregnancy.fetusKg * NUTRIENT_PER_KG_BIOMASS;
      append(state, log, 'human_pregnancy_lost', to, mother, pregnancy.fatherId,
        { returnedKg: pregnancy.fetusKg }, { reason: !mother.alive ? 'mother_died' : state.people.length >= MAX_PEOPLE ? 'capacity' : 'insufficient_growth' });
      mother.pregnancy = null;
      continue;
    }
    const idNumber = state.nextPersonSeq!++;
    const proposed = { ...mother.position, x: mother.position.x + .3 };
    const child: Person = {
      id: `person_${String(idNumber).padStart(4, '0')}`, name: `${names[(idNumber - 5) % names.length]!} ${idNumber}`,
      householdId: state.householdId, appearanceSeed: spatialHash(`${state.id}:child:${idNumber}`),
      ageDays: 0, massKg: pregnancy.fetusKg, alive: true, diedAt: null, patchId: mother.patchId,
      position: positionInPatch(gridOfPatches(patches), proposed, mother.patchId) ? proposed : { ...mother.position }, health: 1,
      needs: { hunger: .15, thirst: .15, fatigue: .1 },
      skills: { gathering: .1, building: .1, fishing: .1, hunting: .1 },
      inventory: { ...emptyCommunityInventory(), rawMeatKg: 0 }, task: null, retryAfter: {},
      visitedSites: [{ patchId: mother.patchId, at: to }], bornAt: to, motherId: mother.id,
      fatherId: pregnancy.fatherId, generation: Math.max(mother.generation ?? 0,
        state.people.find(p => p.id === pregnancy.fatherId)?.generation ?? 0) + 1,
      reproductiveRole: spatialHash(`${state.id}:role:${idNumber}`) % 2 ? 'gestational' : 'non_gestational',
      lastBirthAt: null, pregnancy: null,
    };
    state.people.push(child);
    mother.lastBirthAt = to;
    if (state.building.stage === 'occupied' && homeCondition(state) >= .4) state.building.occupantIds.push(child.id);
    append(state, log, 'human_born', to, mother, child.fatherId!, { massKg: child.massKg },
      { childId: child.id, generation: child.generation!, location: 'mother_contact' });
    mother.pregnancy = null;
  }
  // One deterministic roll per pair and world-day. Rechecking local contact hourly makes a
  // real meeting possible without multiplying the day's conception probability.
  if (Math.floor(from / 3600) === Math.floor(to / 3600)) return;
  const day = Math.floor(to / DAY);
  for (const mother of state.people) {
    if (!mother.alive || mother.reproductiveRole !== 'gestational' || mother.pregnancy
      || mother.ageDays < 18 * 360 || mother.ageDays > 42 * 360 || mother.health < .6
      || mother.needs.hunger >= .7 || mother.needs.thirst >= .7
      || mother.lastBirthAt !== null && mother.lastBirthAt !== undefined && to - mother.lastBirthAt < 2 * 360 * DAY) continue;
    const candidates = state.people.filter(father => father.alive && father.reproductiveRole === 'non_gestational'
      && father.ageDays >= 18 * 360 && father.ageDays <= 60 * 360 && father.health >= .6
      && father.needs.hunger < .7 && father.needs.thirst < .7 && !closeKin(state, mother, father)
      && father.patchId === mother.patchId && distance(mother, father) <= 3)
      .map(father => ({ father, edge: state.relationships?.find(r => r.members.includes(mother.id) && r.members.includes(father.id)) }))
      .filter(pair => (pair.edge?.sharedWorkSeconds ?? 0) >= 3600)
      .sort((a, b) => (b.edge?.trust ?? 0) - (a.edge?.trust ?? 0) || (a.father.id < b.father.id ? -1 : a.father.id > b.father.id ? 1 : 0));
    const pair = candidates[0]; if (!pair || state.people.length >= MAX_PEOPLE) continue;
    const roll = spatialHash(`${state.id}:conception:${day}:${mother.id}:${pair.father.id}`) / 0x1_0000_0000;
    if (roll >= .04) continue;
    const conceived = log.append({ type: 'human_conceived', worldTime: Math.floor(to), simVersion: '', patchId: mother.patchId,
      position: { ...mother.position }, actors: [mother.id, pair.father.id, state.id],
      conditions: { dailyRoll: roll, model: 'fictional_household_v7' }, outcome: 'success',
      effects: { sharedWorkSeconds: pair.edge!.sharedWorkSeconds }, causalParents: [], confidence: 'authoritative' });
    mother.pregnancy = { fatherId: pair.father.id, conceivedAt: to, dueAt: to + GESTATION_DAYS * DAY,
      fetusKg: 0, conceivedEventId: conceived.id };
  }
}
