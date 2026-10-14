import { ISLAND_GRID, gridOfPatches, habitatAnalogue, inCongoChannel, type WorldGrid,
  HOME_STAGES, NUTRIENT_PER_KG_BIOMASS, emptyCommunityInventory, islandHeightAt, landWalkable, homeCondition,
  patchCentre, patchAtPosition, spatialHash, waterAccessPosition, atWaterAccess,
  takeEdibleMass, type Agent, type Carcass, type CommunityState, type HumanAction, type Person, type Patch, type WaterBudget, type WorldEvent, type WorldPosition, type MicroEcologyState, type MicroPatchPopulation,
} from '@vana/shared';
import type { EventLog } from './events/log.js';
import { learnFromSharedWork, workSkill, type HumanWorkWindow } from './communitySocial.js';
import { homeRepairNeeds, repairHome, sleepRecoveryFactor, weatherHome } from './communityMaintenance.js';
import { humanRoute, nearbyResource, explorationSite, travelHuman } from './communityNavigation.js';
import { CommunityRecorder } from './communityRecording.js';
import { advanceCommunityFamily, dependentChild, retainPrenatalFood } from './communityFamily.js';

const DAY = 86_400, EPS = 1e-8;
const duration: Record<HumanAction, number> = {
  gather_food: 900, collect_water: 300, gather_timber: 1800, gather_fibre: 1200,
  deliver: 60, eat: 600, drink: 120, sleep: 3600, build: 1800, rest: 900,
  fish: 1800, cook: 1200, repair: 1800, seek_resources: 300, hunt: 1200, care_child: 600,
};
const distance = (a: WorldPosition, b: WorldPosition) => Math.hypot(a.x - b.x, a.z - b.z);
const biomass = (kg: number) => kg * NUTRIENT_PER_KG_BIOMASS;
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Wildlife mutations remain owned by World, never by an observer or a client. */
export interface CommunityWildlife {
  /** Animal decisions for this tick settle here; a hunt cannot claim an earlier outcome. */
  boundaryAt?: number;
  nearbyPrey(person: Person): Agent | null;
  preyById(id: string): Agent | null;
  kill(prey: Agent, hunter: Person, at: number, taskEventId: string): Carcass;
}

/** A bounded local work area on core dry land. Full flood/obstacle siting is separate. */
export function foundCommunity(patches: readonly Patch[], seed: number, log: EventLog, version: 2 | 3 | 4 | 5 | 6 | 7 | 8 = 8): CommunityState {
  const grid = gridOfPatches(patches), congo = patches[0]?.congoSeed !== undefined;
  // A Congo habitat stands in for the island habitat it resembles (terra firme as shola, a bai as
  // grassland). The Congo forest's village is a riverside one, in flooded forest, so it can fish.
  const site = patches.filter(p => landWalkable(p) && ['grassland', 'shola', 'riparian'].includes(habitatAnalogue(p.habitat))
    && (!congo || p.habitat === 'flooded_forest')
    && p.waterVolume >= 100 && p.plant.browse >= 500 && p.plant.grass >= 100)
    .filter(p => {
      // A Congo home stands clear of any river channel.
      if (p.congoSeed !== undefined) { const c = patchCentre(grid, p.id); return !inCongoChannel(grid, p.congoSeed, c.x + 30, c.z + 30); }
      if (p.islandSeed === undefined) return true;
      const c = patchCentre(grid, p.id), h = islandHeightAt(p.islandSeed, c.x + 30, c.z + 30);
      return h > 3 && [[-4, -4], [4, -4], [-4, 4], [4, 4]].every(([x, z]) =>
        Math.abs(islandHeightAt(p.islandSeed!, c.x + 30 + x!, c.z + 30 + z!) - h) < 1);
    })
    .sort((a, b) => spatialHash(`household:${seed}:${a.id}`) - spatialHash(`household:${seed}:${b.id}`))[0];
  if (!site) throw new Error('no suitable community site; refuse to invent supplies or place people offshore');
  const centre = patchCentre(grid, site.id), home = { x: centre.x + 30, z: centre.z + 30, heading: 0 };
  const state: CommunityState = {
    profile: 'household_v1', version, ...(version >= 3 ? { relationships: [] } : {}), id: 'village_0001', name: congo ? 'Forest Landing' : 'Riverbend', householdId: 'household_0001',
    foundedAt: 0, updatedAt: 0, patchId: site.id, stores: emptyCommunityInventory(),
    ...(version >= 7 ? { nextPersonSeq: 5 } : {}),
    building: { id: 'home_0001', position: home, stage: 'site', labourSeconds: 0,
      materials: { timberKg: 0, fibreKg: 0 }, completedAt: null, occupantIds: [],
      ...(version >= 4 ? { maintenance: { repairsCompleted: 0, lastRepairAt: null,
        ...(version >= 8 ? { collapses: 0, lastCollapseAt: null, lastCollapseEventId: null, rebuildsCompleted: 0 } : {}) } } : {}) },
    // A fictional village: invented names, the Congo forest's its own (owner's default, 14 October 2026).
    people: (congo ? ['Elo', 'Masi', 'Tumo', 'Lina'] : ['Mira', 'Kavi', 'Nila', 'Tavi']).map((name, i) => ({
      id: `person_${String(i + 1).padStart(4, '0')}`, name, householdId: 'household_0001',
      appearanceSeed: spatialHash(`${seed}:${name}`), ageDays: [32, 29, 27, 19][i]! * 360,
      massKg: [62, 71, 58, 64][i]!, alive: true, diedAt: null, patchId: site.id,
      position: { ...home, x: home.x + i * 1.5 }, health: 1,
      needs: { hunger: .2, thirst: .2, fatigue: .15 }, skills: {
        gathering: [.55, .7, .85, .35][i]!, building: [.85, .45, .55, .3][i]!, fishing: [.3, .65, .9, .4][i]!,
        ...(version >= 6 ? { hunting: [.25, .62, .35, .5][i]! } : {}),
      }, inventory: emptyCommunityInventory(), task: null, retryAfter: {},
      ...(version >= 5 ? { visitedSites: [{ patchId: site.id, at: 0 }] } : {}),
      ...(version >= 7 ? { bornAt: 0, motherId: null, fatherId: null, generation: 0,
        reproductiveRole: i % 2 === 0 ? 'gestational' as const : 'non_gestational' as const,
        lastBirthAt: null, pregnancy: null } : {}),
    })),
  };
  if (version >= 6) {
    state.stores.rawMeatKg = 0;
    for (const p of state.people) p.inventory.rawMeatKg = 0;
  }
  emit(state, null, log, 'community_founded', 0, 'success', { profile: state.profile, rulesVersion: state.version }, { founders: state.people.length });
  return state;
}

function emit(state: CommunityState, person: Person | null, log: EventLog, type: WorldEvent['type'], at: number,
  outcome: WorldEvent['outcome'], conditions: WorldEvent['conditions'] = {}, effects: WorldEvent['effects'] = {}, parents: string[] = []): WorldEvent {
  return log.append({ type, worldTime: Math.floor(at), simVersion: '', patchId: person?.patchId ?? state.patchId,
    position: { ...(person?.position ?? state.building.position) },
    actors: person ? [person.id, state.id, state.building.id] : [state.id, state.building.id],
    goal: person?.task?.kind ?? 'settle', conditions, outcome, effects, causalParents: parents, confidence: 'authoritative' });
}

function destination(state: CommunityState, person: Person, kind: HumanAction, site = state.patchId, grid: WorldGrid = ISLAND_GRID): WorldPosition {
  const c = patchCentre(grid, site);
  if (kind === 'collect_water' || kind === 'fish') return waterAccessPosition(grid, site);
  if (kind === 'seek_resources') return { ...c, heading: 0 };
  if (kind.startsWith('gather_')) return { x: c.x - 35, z: c.z + (kind === 'gather_fibre' ? -35 : 0), heading: 0 };
  if (['deliver', 'sleep', 'build', 'rest', 'cook', 'repair'].includes(kind)) return { ...state.building.position };
  return { ...person.position };
}

function careTarget(state: CommunityState, caregiver: Person): Person | null {
  if (state.version < 7 || dependentChild(caregiver, state.version)) return null;
  return state.people.filter(child => child.alive && dependentChild(child, state.version)
    && (child.needs.hunger >= .4 || child.needs.thirst >= .4)
    && !state.people.some(other => other.task?.kind === 'care_child' && other.task.targetPersonId === child.id)
    && (child.patchId === caregiver.patchId || child.patchId === state.patchId))
    .sort((a, b) => Number(b.motherId === caregiver.id || b.fatherId === caregiver.id)
      - Number(a.motherId === caregiver.id || a.fatherId === caregiver.id)
      || Math.max(a.needs.hunger, a.needs.thirst) - Math.max(b.needs.hunger, b.needs.thirst)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

function choose(state: CommunityState, p: Person, at: number, patch: Patch, pool: MicroPatchPopulation | undefined,
  patches: Patch[], micro?: MicroEcologyState, wildlife?: CommunityWildlife): HumanAction {
  const ready = (kind: HumanAction) => (p.retryAfter[kind] ?? 0) <= at;
  const accessible = (kind: HumanAction) => state.version < 5 || nearbyResource(p, kind, patches, micro) !== null;
  const fishing = state.version >= 2 && ready('fish') && (state.version >= 5 ? accessible('fish') : fishable(patch, pool))
    && ((p.skills.fishing ?? 0) >= p.skills.gathering || !ready('gather_food'));
  const foodAction = (): HumanAction | null => state.version >= 6 && p.ageDays >= 16 * 360 && ready('hunt') && wildlife?.nearbyPrey(p) ? 'hunt'
    : fishing ? 'fish' : ready('gather_food') && accessible('gather_food') ? 'gather_food'
    : state.version >= 5 && ready('fish') && accessible('fish') ? 'fish'
    : state.version >= 5 ? 'seek_resources' : null;
  if (p.needs.thirst >= .4) {
    if (p.inventory.waterL > EPS) return 'drink';
    // Stored water is at home. Return before withdrawing it, just like a stored meal.
    if (state.stores.waterL > EPS) return 'deliver';
    if (ready('collect_water') && accessible('collect_water')) return 'collect_water';
    if (state.version >= 5) return 'seek_resources';
  }
  const child = careTarget(state, p);
  if (child && ready('care_child') && p.needs.hunger < .8 && p.needs.thirst < .8) {
    const needsFood = child.needs.hunger >= .4, needsWater = child.needs.thirst >= .4;
    if ((!needsFood || p.inventory.foodKg >= .2) && (!needsWater || p.inventory.waterL >= .3)) return 'care_child';
    if (distance(p.position, state.building.position) < 1
      && (!needsFood || state.stores.foodKg >= .2) && (!needsWater || state.stores.waterL >= .3)) return 'care_child';
    if (state.stores.foodKg >= .2 || state.stores.waterL >= .3) return 'deliver';
  }
  if (state.version >= 2 && ((p.inventory.rawFishKg ?? 0) > EPS || (p.inventory.rawMeatKg ?? 0) > EPS)) return 'deliver';
  // Finish the current supply trip before assigning more fuel work. Otherwise a
  // raw catch in shared stores can keep every worker gathering timber forever:
  // fuel is carried in personal inventory while the cook checks home stores.
  const stock = p.inventory;
  if (stock.timberKg + stock.fibreKg > EPS || stock.foodKg >= 1 || stock.waterL >= 2) return 'deliver';
  if (state.version >= 2 && ((state.stores.rawFishKg ?? 0) > EPS || (state.stores.rawMeatKg ?? 0) > EPS)
    && (p.needs.hunger >= .45 || state.stores.foodKg < state.people.filter(a => a.alive).length * .7)) {
    if (state.stores.timberKg > EPS && ready('cook')) return 'cook';
    if (ready('gather_timber')) return 'gather_timber';
  }
  if (p.needs.hunger >= .45) {
    if (p.inventory.foodKg > EPS) return 'eat';
    if (state.stores.foodKg > EPS) return 'deliver'; // go home; next decision can take a meal
    const action = foodAction(); if (action) return action;
  }
  if (p.needs.fatigue >= .72 || (Math.floor(at / 3600) % 24 >= 21 && p.needs.fatigue >= .25)) return 'sleep';
  if (state.stores.foodKg < state.people.filter(a => a.alive).length * .7) {
    const action = foodAction(); if (action) return action;
  }
  if (state.stores.waterL < state.people.filter(a => a.alive).length && ready('collect_water')) return 'collect_water';
  if (state.version >= 4 && state.building.stage === 'occupied' && homeCondition(state) < .9 && ready('repair')) {
    const need = homeRepairNeeds(state, p);
    const incoming = (key: 'timberKg' | 'fibreKg', kind: HumanAction) => state.people.filter(a => a.alive)
      .reduce((sum, a) => sum + a.inventory[key] + (a.task?.kind === kind ? 6 : 0), 0);
    if (state.stores.timberKg + incoming('timberKg', 'gather_timber') + EPS < need.timberKg && ready('gather_timber')) return 'gather_timber';
    if (state.stores.fibreKg + incoming('fibreKg', 'gather_fibre') + EPS < need.fibreKg && ready('gather_fibre')) return 'gather_fibre';
    if (state.stores.timberKg + EPS >= need.timberKg && state.stores.fibreKg + EPS >= need.fibreKg) return 'repair';
  }
  const stage = HOME_STAGES.find(s => s.from === state.building.stage);
  if (stage) {
    // Account for actual carried stock and outstanding gather tasks before sending more workers.
    const incoming = (key: 'timberKg' | 'fibreKg', kind: HumanAction) => state.people.filter(a => a.alive)
      .reduce((sum, a) => sum + a.inventory[key] + (a.task?.kind === kind ? 6 : 0), 0);
    if (state.stores.timberKg + incoming('timberKg', 'gather_timber') < stage.timberKg && ready('gather_timber')) return 'gather_timber';
    if (state.stores.fibreKg + incoming('fibreKg', 'gather_fibre') < stage.fibreKg && ready('gather_fibre')) return 'gather_fibre';
    if (state.stores.timberKg >= stage.timberKg && state.stores.fibreKg >= stage.fibreKg) return 'build';
  }
  return 'rest';
}

function start(state: CommunityState, p: Person, at: number, log: EventLog, patch: Patch, pool: MicroPatchPopulation | undefined,
  patches: Patch[], micro?: MicroEcologyState, wildlife?: CommunityWildlife): void {
  if (state.version >= 5) {
    const visit = p.visitedSites!.find(v => v.patchId === p.patchId);
    if (visit) visit.at = at; else p.visitedSites!.push({ patchId: p.patchId, at });
  }
  let kind = choose(state, p, at, patch, pool, patches, micro, wildlife), site = state.patchId;
  const prey = kind === 'hunt' ? wildlife?.nearbyPrey(p) : null;
  const child = kind === 'care_child' ? careTarget(state, p) : null;
  if (kind === 'hunt' && !prey) kind = 'rest';
  if (kind === 'care_child' && !child) kind = 'rest';
  if (state.version >= 5) {
    if (kind.startsWith('gather_') || kind === 'collect_water' || kind === 'fish') {
      const source = nearbyResource(p, kind, patches, micro);
      if (source === null) kind = 'seek_resources'; else site = source;
    }
    if (kind === 'seek_resources') {
      const unexplored = explorationSite(p, patches);
      if (unexplored === null) kind = 'rest'; else site = unexplored;
    }
  }
  const target = kind === 'hunt' && prey?.position ? { ...prey.position }
    : kind === 'care_child' && child ? { ...child.position } : destination(state, p, kind, site, gridOfPatches([patch]));
  // Shared supplies can only be withdrawn when physically at the household.
  if (distance(p.position, state.building.position) < 1) {
    for (const [key, need, max] of [['foodKg', p.needs.hunger >= .45, .7], ['waterL', p.needs.thirst >= .4, 1]] as const) {
      if (need && p.inventory[key] <= EPS) { const n = Math.min(max, state.stores[key]); state.stores[key] -= n; p.inventory[key] += n; }
    }
    if (kind === 'care_child' && child) {
      if (child.needs.hunger >= .4) { const n = Math.min(.45, state.stores.foodKg); state.stores.foodKg -= n; p.inventory.foodKg += n; }
      if (child.needs.thirst >= .4) { const n = Math.min(.8, state.stores.waterL); state.stores.waterL -= n; p.inventory.waterL += n; }
    }
  }
  const actual = p.needs.thirst >= .4 && p.inventory.waterL > EPS ? 'drink'
    : p.needs.hunger >= .45 && p.inventory.foodKg > EPS ? 'eat' : kind;
  p.task = { kind: actual, phase: 'travel', destination: actual === kind ? target : { ...p.position },
    remainingSeconds: duration[actual], startedAt: at, eventId: '',
    ...(actual === 'hunt' && prey ? { targetAgentId: prey.id } : {}) };
  if (actual === 'care_child' && child) p.task.targetPersonId = child.id;
  let blocked = false;
  if (state.version >= 5) {
    let points = humanRoute(p.position, p.task.destination, patches);
    if (!points) {
      blocked = true; p.retryAfter[actual] = at + 3600;
      p.task = { ...p.task, kind: 'rest', destination: { ...p.position }, remainingSeconds: duration.rest };
      delete p.task.targetAgentId;
      delete p.task.targetPersonId;
      points = [{ ...p.position }];
    }
    p.task.journey = { destinationPatchId: patchAtPosition(gridOfPatches([patch]), p.task.destination), waypoints: points };
  }
  p.task.eventId = emit(state, p, log, 'human_task_started', at, 'success', { action: p.task.kind,
    ...(state.version >= 5 ? { destinationPatchId: p.task.journey!.destinationPatchId } : {}),
    ...(blocked ? { reason: 'no_land_route', requestedAction: actual } : {}) }).id;
}

/** Local freshwater-stock check only; no knowledge of remote fish pools. */
function fishable(patch: Patch, pool: MicroPatchPopulation | undefined): boolean {
  return patch.surface !== 'ocean' && patch.surface !== 'coast' && patch.waterVolume >= 20
    && ['riparian', 'marsh', 'water'].includes(patch.habitat) && (pool?.fishBiomassKg ?? 0) >= .05;
}

function finish(state: CommunityState, p: Person, patch: Patch, budget: WaterBudget, at: number, log: EventLog,
  pool: MicroPatchPopulation | undefined, wildlife?: CommunityWildlife): void {
  const task = p.task!; let outcome: WorldEvent['outcome'] = 'success';
  const effects: Record<string, number> = {};
  const conditions: WorldEvent['conditions'] = { action: task.kind,
    ...(state.version >= 5 ? { sourcePatchId: patch.id } : {}) };
  if (state.version >= 5 && (distance(p.position, task.destination) > 1e-6
    || ['deliver', 'build', 'cook', 'repair'].includes(task.kind)
      && (p.patchId !== state.patchId || distance(p.position, state.building.position) > 1))) {
    p.retryAfter[task.kind] = at + 3600;
    emit(state, p, log, 'human_task_finished', at, 'failure', { ...conditions, reason: 'no_required_contact' }, {}, [task.eventId]);
    p.task = null; return;
  }
  switch (task.kind) {
    case 'care_child': {
      const child = state.people.find(a => a.id === task.targetPersonId);
      if (!child?.alive || !dependentChild(child, state.version) || child.patchId !== p.patchId
        || distance(p.position, child.position) > 2) {
        outcome = 'failure'; conditions.reason = 'child_gone_or_no_contact'; break;
      }
      const food = child.needs.hunger >= .35 ? Math.min(.45, p.inventory.foodKg) : 0;
      const water = child.needs.thirst >= .35 ? Math.min(.8, p.inventory.waterL) : 0;
      if (food + water <= EPS) { outcome = 'failure'; conditions.reason = 'no_carried_supplies'; break; }
      p.inventory.foodKg -= food; p.inventory.waterL -= water;
      const growth = Math.min(food * .03, Math.max(0, 20 - child.massKg));
      child.massKg += growth;
      patch.soilNutrients += biomass(food - growth);
      child.needs.hunger = clamp(child.needs.hunger - food * 1.5);
      child.needs.thirst = clamp(child.needs.thirst - water * .8);
      conditions.childId = child.id; conditions.relationship = child.motherId === p.id || child.fatherId === p.id ? 'parent' : 'household';
      effects.foodKg = -food; effects.waterL = -water; effects.childGrowthKg = growth;
      log.append({ type: 'human_cared', worldTime: Math.floor(at), simVersion: '', patchId: p.patchId,
        position: { ...p.position }, actors: [child.id, p.id, state.id], goal: 'care_child',
        conditions, outcome: 'success', effects, causalParents: [task.eventId], confidence: 'authoritative' });
      break;
    }
    case 'hunt': {
      const prey = wildlife?.preyById(task.targetAgentId ?? '');
      const gap = prey?.position ? distance(p.position, prey.position) : Infinity;
      const skill = p.skills.hunting ?? 0;
      const chance = prey ? Math.min(.8, (.18 + .52 * skill) * Math.min(1, 45 / Math.max(1, prey.massKg))) : 0;
      const roll = spatialHash(`${task.eventId}:hunt`) / 0x1_0000_0000;
      Object.assign(conditions, { preyId: task.targetAgentId ?? '', preySpecies: prey?.speciesId ?? 'absent',
        preyMassKg: prey?.massKg ?? 0, contactDistanceM: Number.isFinite(gap) ? gap : -1, catchChance: chance, roll });
      if (!prey?.alive || gap > 3 || prey.patchId !== p.patchId) {
        outcome = 'failure'; conditions.reason = 'prey_gone_or_no_contact';
      } else if (roll >= chance) {
        outcome = 'failure'; conditions.reason = 'prey_escaped';
        p.health = clamp(p.health - .01 * Math.min(2, prey.massKg / 25));
      } else {
        const carcass = wildlife!.kill(prey, p, at, task.eventId);
        const taken = takeEdibleMass(carcass.biomass, Math.max(0, 3 - (p.inventory.rawMeatKg ?? 0)));
        p.inventory.rawMeatKg = (p.inventory.rawMeatKg ?? 0) + taken;
        carcass.consumers.push({ agentId: p.id, at, kg: taken });
        effects.rawMeatKg = taken;
        conditions.reason = 'caught'; conditions.carcassId = carcass.id;
      }
      p.skills.hunting = Math.min(1, skill + (outcome === 'success' ? .003 : .0005));
      p.retryAfter.hunt = at + (outcome === 'success' ? 6 : 3) * 3600;
      emit(state, p, log, 'human_hunt', at, outcome, conditions, effects, [task.eventId]);
      break;
    }
    case 'repair': {
      const used = repairHome(state, p, at, log); Object.assign(effects, used);
      if (used.timberKg + used.fibreKg <= EPS) { outcome = 'failure'; conditions.reason = homeCondition(state) >= .99 ? 'home_already_repaired' : 'no_delivered_materials_or_home_contact'; }
      else { conditions.reason = 'repaired'; effects.condition = homeCondition(state); }
      break;
    }
    case 'fish': {
      // The roll derives from the persisted attempt, not a fresh post-restart draw or viewer input.
      const before = pool?.fishBiomassKg ?? 0;
      const chance = (.15 + .65 * (p.skills.fishing ?? 0)) * Math.min(1, before / .3);
      const roll = spatialHash(`${task.eventId}:catch`) / 0x1_0000_0000;
      Object.assign(conditions, { stockBeforeKg: before, catchChance: chance, roll, sourcePatchId: patch.id });
      if (state.version < 2 || !fishable(patch, pool) || !atWaterAccess(gridOfPatches([patch]), p.position, patch.id)) {
        outcome = 'failure'; conditions.reason = 'no_accessible_fish';
      } else if (roll >= chance) { outcome = 'failure'; conditions.reason = 'no_catch'; }
      else {
        const caught = Math.min(before, .1 + .2 * p.skills.fishing!);
        pool!.fishBiomassKg -= caught;
        pool!.fishSchools = pool!.fishBiomassKg < .002 ? 0 : Math.min(40, Math.max(1, Math.round(pool!.fishBiomassKg / .12)));
        p.inventory.rawFishKg = (p.inventory.rawFishKg ?? 0) + caught;
        p.skills.fishing = Math.min(1, p.skills.fishing! + .002);
        effects.rawFishKg = caught; effects.fishBiomassKg = -caught; conditions.reason = 'caught';
      }
      p.retryAfter.fish = at + 3600;
      break;
    }
    case 'cook': {
      // Raw catch is never directly edible. Cooking requires delivered stock, fuel, time and home contact.
      const kg = Math.min((state.stores.rawFishKg ?? 0) + (state.stores.rawMeatKg ?? 0), .5, state.stores.timberKg / .1);
      if (state.version < 2 || kg <= EPS || distance(p.position, state.building.position) > 1) {
        outcome = 'failure'; conditions.reason = 'no_delivered_fish_or_fuel'; break;
      }
      const fuel = kg * .1;
      const fish = Math.min(state.stores.rawFishKg ?? 0, kg), meat = kg - fish;
      state.stores.rawFishKg = Math.max(0, state.stores.rawFishKg! - fish);
      if (state.version >= 6) state.stores.rawMeatKg = Math.max(0, state.stores.rawMeatKg! - meat);
      state.stores.timberKg = Math.max(0, state.stores.timberKg - fuel);
      state.stores.foodKg += kg; patch.soilNutrients += biomass(fuel);
      effects.rawFishKg = -fish; if (state.version >= 6) effects.rawMeatKg = -meat;
      effects.foodKg = kg; effects.fuelKg = fuel;
      conditions.reason = 'cooked'; break;
    }
    case 'gather_food': case 'gather_timber': case 'gather_fibre': {
      const fibre = task.kind === 'gather_fibre', food = task.kind === 'gather_food';
      const key = food ? 'foodKg' : fibre ? 'fibreKg' : 'timberKg';
      const plant = fibre ? 'grass' : 'browse';
      const n = Math.min(patch.plant[plant], (food ? 1.5 : 6) * (.5 + .5 * p.skills.gathering));
      patch.plant[plant] -= n; p.inventory[key] += n; effects[key] = n;
      if (n <= EPS) outcome = 'failure'; else p.skills.gathering = Math.min(1, p.skills.gathering + .001);
      break;
    }
    case 'collect_water': {
      const n = Math.min(patch.waterVolume, 4); patch.waterVolume -= n; p.inventory.waterL += n;
      budget.communityWithdrawalL = (budget.communityWithdrawalL ?? 0) + n;
      effects.waterL = n; if (n <= EPS) outcome = 'failure'; break;
    }
    case 'deliver': {
      for (const key of ['foodKg', 'timberKg', 'fibreKg', 'waterL'] as const) {
        effects[key] = p.inventory[key]; state.stores[key] += p.inventory[key]; p.inventory[key] = 0;
      }
      if (state.version >= 2) {
        effects.rawFishKg = p.inventory.rawFishKg ?? 0;
        state.stores.rawFishKg = (state.stores.rawFishKg ?? 0) + effects.rawFishKg;
        p.inventory.rawFishKg = 0;
      }
      if (state.version >= 6) {
        effects.rawMeatKg = p.inventory.rawMeatKg ?? 0;
        state.stores.rawMeatKg = (state.stores.rawMeatKg ?? 0) + effects.rawMeatKg;
        p.inventory.rawMeatKg = 0;
      }
      break;
    }
    case 'eat': {
      const kg = Math.min(p.inventory.foodKg, .7, p.needs.hunger / .65);
      p.inventory.foodKg -= kg; p.needs.hunger = clamp(p.needs.hunger - kg * .65);
      const prenatal = state.version >= 7 ? retainPrenatalFood(p, kg) : 0;
      patch.soilNutrients += biomass(kg - prenatal); effects.foodKg = kg;
      if (prenatal > 0) effects.prenatalGrowthKg = prenatal;
      if (kg <= EPS) outcome = 'failure'; break;
    }
    case 'drink': {
      const litres = Math.min(p.inventory.waterL, 1, p.needs.thirst / .6);
      p.inventory.waterL -= litres; p.needs.thirst = clamp(p.needs.thirst - litres * .6);
      effects.waterL = litres; if (litres <= EPS) outcome = 'failure'; break;
    }
    case 'seek_resources': conditions.reason = 'site_explored'; break;
    case 'sleep': case 'rest': break; // recovery is paid continuously by actual resting time
    case 'build': {
      const spec = HOME_STAGES.find(s => s.from === state.building.stage);
      if (!spec || state.stores.timberKg + EPS < spec.timberKg || state.stores.fibreKg + EPS < spec.fibreKg) { outcome = 'failure'; break; }
      // Construction work is accrued only at contact; stage resources transfer once atomically.
      const work = Math.min(spec.labourSeconds - state.building.labourSeconds, duration.build * (.5 + p.skills.building));
      state.building.labourSeconds += work; effects.labourSeconds = work;
      p.skills.building = Math.min(1, p.skills.building + .002);
      if (state.building.labourSeconds >= spec.labourSeconds - EPS) {
        state.stores.timberKg = Math.max(0, state.stores.timberKg - spec.timberKg);
        state.stores.fibreKg = Math.max(0, state.stores.fibreKg - spec.fibreKg);
        state.building.materials.timberKg += spec.timberKg; state.building.materials.fibreKg += spec.fibreKg;
        state.building.stage = spec.to; state.building.labourSeconds = 0;
        if (spec.to === 'occupied') {
          state.building.completedAt = at; state.building.occupantIds = state.people.filter(a => a.alive).map(a => a.id);
        }
        const stageEvent = emit(state, p, log, 'building_stage', at, 'success', { from: spec.from, to: spec.to },
          { timberKg: spec.timberKg, fibreKg: spec.fibreKg }, [task.eventId]);
        const m = state.building.maintenance;
        if (spec.to === 'occupied' && state.version >= 8 && m && m.collapses! > m.rebuildsCompleted!) {
          m.rebuildsCompleted = m.collapses!;
          const rebuilt = log.append({ type: 'building_rebuilt', worldTime: Math.floor(at), simVersion: '', patchId: state.patchId,
            position: { ...state.building.position }, actors: [p.id, state.id, state.building.id], goal: 'rebuild',
            conditions: { collapsedAt: m.lastCollapseAt! }, effects: { rebuildsCompleted: m.rebuildsCompleted },
            outcome: 'success', causalParents: [m.lastCollapseEventId!, stageEvent.id], confidence: 'authoritative' });
          log.append({ type: 'building_shelter_changed', worldTime: Math.floor(at), simVersion: '', patchId: state.patchId,
            position: { ...state.building.position }, actors: [state.id, state.building.id], goal: 'shelter',
            conditions: { reason: 'rebuilt', availability: 'habitable' },
            effects: { condition: homeCondition(state), residents: state.building.occupantIds.length },
            outcome: 'success', causalParents: [rebuilt.id], confidence: 'authoritative' });
        }
      }
      break;
    }
  }
  if (outcome === 'failure') p.retryAfter[task.kind] = at + 3600;
  if (state.version >= 5 && p.patchId !== state.patchId && outcome === 'success'
    && (task.kind.startsWith('gather_') || task.kind === 'collect_water' || task.kind === 'fish'))
    emit(state, p, log, 'human_resource_collected', at, 'success',
      { ...conditions, homePatchId: state.patchId }, effects, [task.eventId]);
  emit(state, p, log, 'human_task_finished', at, outcome, conditions, effects, [task.eventId]);
  p.task = null;
}

/** Sequential one-minute slices: finite shared stocks, no viewer input or model decisions. */
export function stepCommunity(state: CommunityState, patches: Patch[], budget: WaterBudget,
  startAt: number, seconds: number, log: EventLog, microEcology?: MicroEcologyState,
  wildlife?: CommunityWildlife): void {
  const homePatch = patches[state.patchId]!;
  const pools = new Map(microEcology?.patches.map(p => [p.patchId, p]));
  if (state.updatedAt !== startAt || !Number.isFinite(seconds) || seconds <= 0) throw new Error('invalid community clock');
  const recording = new CommunityRecorder(state, startAt, seconds);
  let elapsed = 0;
  while (elapsed < seconds - EPS) {
    const dt = Math.min(60, seconds - elapsed), now = startAt + elapsed;
    const workWindows: HumanWorkWindow[] = [];
    weatherHome(state, homePatch, dt, now, log, budget);
    // Food spoilage returns to the same soil; timber/fibre remain in stores/building.
    for (const [stock, patch] of [[state.stores, homePatch] as const, ...state.people.map(p =>
      [p.inventory, state.version >= 5 ? patches[p.patchId]! : homePatch] as const)]) {
      const decay = stock.foodKg * (1 - Math.exp(-dt / (3 * DAY))); stock.foodKg -= decay; patch.soilNutrients += biomass(decay);
      if (state.version >= 2) {
        const rawDecay = (stock.rawFishKg ?? 0) * (1 - Math.exp(-dt / DAY));
        stock.rawFishKg = (stock.rawFishKg ?? 0) - rawDecay; patch.soilNutrients += biomass(rawDecay);
      }
      if (state.version >= 6) {
        const meatDecay = (stock.rawMeatKg ?? 0) * (1 - Math.exp(-dt / DAY));
        stock.rawMeatKg = (stock.rawMeatKg ?? 0) - meatDecay; patch.soilNutrients += biomass(meatDecay);
      }
    }
    for (const p of state.people) {
      const patch = state.version >= 5 ? patches[p.patchId]! : homePatch;
      if (!p.alive) {
        const decay = p.massKg * (1 - Math.exp(-dt / (30 * DAY))); p.massKg -= decay; patch.soilNutrients += biomass(decay);
        recording.capture(p, now); continue;
      }
      p.ageDays += dt / DAY;
      const dependent = dependentChild(p, state.version);
      p.needs.hunger = clamp(p.needs.hunger + dt / ((dependent ? 20 : 36) * 3600));
      p.needs.thirst = clamp(p.needs.thirst + dt / ((dependent ? 12 : 16) * 3600));
      const critical = p.needs.thirst > .95 || p.needs.hunger > .95 || p.ageDays > 90 * 360;
      p.health = clamp(p.health + (critical ? -dt / DAY : dt / (10 * DAY)));
      if (p.health <= EPS) {
        if (p.task) emit(state, p, log, 'human_task_interrupted', now, 'interrupted', { action: p.task.kind, reason: 'death' }, {}, [p.task.eventId]);
        p.alive = false; p.diedAt = now; p.task = null;
        // Body remains a decaying stock; belongings are not teleported into the household.
        emit(state, p, log, 'human_died', now, 'success', { cause: p.needs.thirst > .95 ? 'dehydration' : p.needs.hunger > .95 ? 'starvation' : 'aging' });
        state.building.occupantIds = state.building.occupantIds.filter(id => id !== p.id); recording.capture(p, now); continue;
      }
      if (dependent) { recording.capture(p, now); continue; }
      if (p.task && !['eat', 'drink', 'gather_food', 'collect_water', 'deliver', 'fish', 'cook',
        ...(state.version >= 5 ? ['seek_resources', 'rest'] : [])].includes(p.task.kind)
        && (p.needs.thirst > .8 || p.needs.hunger > .85)) {
        emit(state, p, log, 'human_task_interrupted', now, 'interrupted', { action: p.task.kind, reason: 'urgent_need' }, {}, [p.task.eventId]);
        p.task = null;
      }
      let remaining = dt;
      while (remaining > EPS) {
        if (!p.task) start(state, p, now + dt - remaining, log, patches[p.patchId]!, pools.get(p.patchId), patches, microEcology, wildlife);
        recording.capture(p, now + dt - remaining);
        const task = p.task!;
        if (task.phase === 'travel') {
          if (state.version >= 5) {
            const travelAt = now + dt - remaining;
            const used = travelHuman(p, task, patches, remaining, spent => recording.capture(p, travelAt + spent));
            p.needs.fatigue = clamp(p.needs.fatigue + used / (20 * 3600)); remaining -= used;
            if (task.journey!.waypoints.length) break;
            task.phase = 'work';
          } else {
          const gap = distance(p.position, task.destination), speed = 1.1 * (.6 + .4 * p.health);
          const used = Math.min(remaining, gap / speed), fraction = gap > EPS ? Math.min(1, used * speed / gap) : 1;
          if (gap > EPS) p.position.heading = Math.atan2(task.destination.x - p.position.x, task.destination.z - p.position.z);
          p.position.x += (task.destination.x - p.position.x) * fraction; p.position.z += (task.destination.z - p.position.z) * fraction;
          recording.capture(p, now + dt - remaining + used);
          p.needs.fatigue = clamp(p.needs.fatigue + used / (20 * 3600)); remaining -= used;
          if (fraction < 1) break;
          task.phase = 'work';
          }
        }
        recording.capture(p, now + dt - remaining);
        const used = Math.min(remaining, task.remainingSeconds);
        const skill = workSkill(task.kind);
        if (state.version >= 3 && skill && used > 0) workWindows.push({
          personId: p.id, action: task.kind, start: now + dt - remaining, end: now + dt - remaining + used,
          position: { ...p.position }, taskEventId: task.eventId, skill, skillValue: p.skills[skill] ?? 0,
        });
        task.remainingSeconds -= used; remaining -= used;
        p.needs.fatigue = clamp(p.needs.fatigue + used * (task.kind === 'sleep' ? -sleepRecoveryFactor(state, p) / (8 * 3600)
          : task.kind === 'rest' ? -1 / (24 * 3600) : 1 / (24 * 3600)));
        if (task.remainingSeconds <= EPS) {
          const completedAt = now + dt - remaining;
          if (task.kind === 'hunt' && wildlife?.boundaryAt !== undefined && completedAt < wildlife.boundaryAt - EPS)
            task.remainingSeconds = wildlife.boundaryAt - completedAt;
          else finish(state, p, patches[p.patchId]!, budget, completedAt, log, pools.get(p.patchId), wildlife);
        }
        recording.capture(p, now + dt - remaining);
      }
    }
    learnFromSharedWork(state, workWindows, log, gridOfPatches(patches));
    advanceCommunityFamily(state, patches, now, now + dt, log);
    elapsed += dt;
  }
  state.updatedAt = startAt + seconds;
  const motion = recording.finish(state);
  if (motion) state.motion = motion; else delete state.motion;
}
