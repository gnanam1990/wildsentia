import { type Agent, type Patch, type SpeciesConfig, type WorldPosition } from '@vana/shared';
import type { EventLog } from '../events/log.js';
import { canFollowParent, careRadius, inCareContact, needsOf, needsProvisioning, provisionYoung } from './needs.js';
import { perceptionRadius } from './perception.js';
import { nursingBudget, nursingEligible, nursingWindow } from './nursing.js';
import { locateAgent, placeBeside } from './spatial.js';
import { navigate } from './navigation.js';

export interface FamilyLocation { patchId: number; position: WorldPosition }
export interface CareVisit { parent: Agent; arrival: number; position: WorldPosition; routeId?: string }

/** A dependent this thirsty is in a hydration emergency: under three days' water deficit
 * is fatal, and at the thirst rate this leaves a little over a day. Matches the urgent thirst
 * at which a mobile dependent stops waiting for its parent (DEPENDENT_URGENT_THIRST). */
export const HYDRATION_EMERGENCY_THIRST = 0.5;

/**
 * Explicit model policy: a caregiver must also eat/drink and respond to danger.
 *
 * sim_0.32.0: hunger alone no longer silences care for a dependent in a hydration
 * emergency. Before, a mother past 0.72 hunger stopped all provisioning, water included,
 * though she had drunk her fill: whole dhole litters and the gaur calves of a famine died of
 * thirst beside a living, watered mother who was out hunting or grazing. A thirsty or
 * frightened parent still cannot answer, and what she gives is still bounded by her own
 * reserves in provisionYoung (no food past the 0.8 donor ceiling, no water past hers).
 */
/** Fear at which a parent breaks off care (and every family routine) to deal with a threat. */
export const CARE_FEAR_BLOCK = 0.5;

export function availableForCare(parent: Agent, child?: Agent): boolean {
  if (!parent.alive || parent.drives.thirst >= 0.65 || parent.drives.fear >= CARE_FEAR_BLOCK) return false;
  return parent.drives.hunger < 0.72 || child !== undefined && child.drives.thirst >= HYDRATION_EMERGENCY_THIRST;
}

export function chooseCareTarget(parent: Agent, children: readonly Agent[], cfg: SpeciesConfig, start = 0, hours = 1): Agent | undefined {
  // A hungry parent is available only to a dependent in a hydration emergency.
  return children.filter((child) => availableForCare(parent, child) && child.alive && child.dependentOn === parent.id
    && child.speciesId === parent.speciesId && needsProvisioning(child, cfg)
    && nursingEligible(child, cfg, start, start + hours * 3600)
    && Math.max(child.drives.hunger, child.drives.thirst) >= (cfg.lifecycle.nursing ? 1e-8 : 0.15))
    .sort((a, b) => Math.max(b.drives.hunger, b.drives.thirst) - Math.max(a.drives.hunger, a.drives.thirst)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/**
 * sim_0.32.0: a parent of young that cannot yet follow it ranges idly only as far as it can
 * perceive them (perceptionRadius patches). Before, an idle mother wandered patch to patch at
 * random: a fed, watered hare was 2 km from her leverets when their nightly nursing window
 * opened, and a whole litter died of thirst. Feeding, drinking, flight and every other need
 * still go wherever they must; only aimless wandering is tethered. Returns where to go back to,
 * or null when the parent is already within range (or has no such young).
 */
export function idleRangeAnchor(parent: Agent, cfg: SpeciesConfig, children: readonly Agent[],
  starts: ReadonlyMap<string, FamilyLocation>, patches: readonly Patch[]): FamilyLocation | null {
  const here = patches[parent.patchId];
  if (!parent.alive || !here) return null;
  let anchor: FamilyLocation | null = null, nearest = Infinity;
  for (const child of [...children].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (!child.alive || child.dependentOn !== parent.id || child.speciesId !== parent.speciesId
      || !needsProvisioning(child, cfg) || canFollowParent(child, cfg)) continue;
    const site = cfg.lifecycle.nursing && child.nursingSite ? child.nursingSite : starts.get(child.id);
    const there = site && patches[site.patchId];
    if (!site || !there) continue;
    const steps = Math.abs(there.x - here.x) + Math.abs(there.y - here.y);
    if (steps < nearest) { nearest = steps; anchor = { patchId: site.patchId, position: { ...site.position } }; }
  }
  return nearest > perceptionRadius(cfg) ? anchor : null;
}

/** Both family actions spend ordinary, age-scaled terrain travel time. A target is a detached
 * start-of-decision location, never the parent's future endpoint. No endpoint teleport. */
export function travelToFamily(agent: Agent, cfg: SpeciesConfig, patches: Patch[], target: FamilyLocation,
  goal: 'care_for_young' | 'follow_parent' | 'seek_nursing' | 'collect_pack_food' | 'deliver_pack_food',
  start: number, hours: number, log: EventLog, radius = careRadius(cfg)): CareVisit {
  agent.currentGoal = goal; agent.alternativeGoal = null; agent.goalScore = 1; agent.targetId = null;
  if (agent.journey?.goal !== goal) delete agent.journey;
  const here = locateAgent(agent);
  const holdingRadius = goal === 'seek_nursing' || cfg.lifecycle.nursing && goal === 'care_for_young' ? radius * 0.5 : radius;
  if (agent.patchId === target.patchId && Math.hypot(here.x - target.position.x, here.z - target.position.z) <= holdingRadius + 1e-8) {
    delete agent.journey; agent.state = 'resting';
    return { parent: agent, arrival: start, position: { ...here } };
  }
  // Deterministic near-side slot, clamped inside the target cell; placement affects this
  // temporary endpoint only. The real animal reaches it exclusively through navigate().
  const slot = { ...agent, patchId: target.patchId };
  // A compact litter spans at most half a contact radius; this slot can reach the group
  // concurrently without changing any offspring position or enlarging the contact test.
  placeBeside(slot, target.position, radius * 0.5);
  const from = agent.patchId;
  const travel = navigate(agent, cfg, patches, target.patchId, goal, start, hours * 3600, false, slot.position!);
  agent.state = travel.trace.completed ? 'resting' : travel.unreachable ? 'resting' : 'travelling';
  const event = log.append({ type: 'moved', worldTime: Math.floor(start + travel.seconds), simVersion: '',
    patchId: agent.patchId, actors: [agent.id], goal, conditions: { from, destination: target.patchId,
      targetX: target.position.x, targetZ: target.position.z, ...(travel.unreachable ? { reason: 'unreachable_terrain' } : {}) },
    outcome: travel.unreachable ? 'abandoned' : travel.trace.completed ? 'success' : 'interrupted',
    effects: { distanceM: travel.distanceM, durationSeconds: travel.seconds, sprintSeconds: 0 },
    causalParents: [], confidence: 'authoritative', movement: travel.trace });
  return { parent: agent, arrival: travel.trace.completed ? start + travel.seconds : Infinity,
    position: { ...locateAgent(agent) }, routeId: event.id };
}

/** Finalize only after all actions: death, escape or another action invalidates this visit.
 * A dependent either stays at its recorded start point or supplies its own completed approach.
 * Contact begins only after both participants arrive, within any species nursing schedule.
 * Multiple nearby littermates may nurse concurrently; each costs the parent's real reserves. */
export function finishCare(visit: CareVisit, children: readonly Agent[], starts: ReadonlyMap<string, FamilyLocation>,
  cfg: SpeciesConfig, start: number, end: number, log: EventLog,
  youngArrivals: ReadonlyMap<string, CareVisit> = new Map()): string[] {
  const served: string[] = [];
  const parent = visit.parent;
  const samePoint = (a: WorldPosition | undefined, b: WorldPosition) => !!a && Math.hypot(a.x - b.x, a.z - b.z) <= 1e-8;
  if (!parent.alive || parent.currentGoal !== 'care_for_young' || parent.lastEncounterAt === start
    || !samePoint(parent.position, visit.position) || !(visit.arrival < end)) return served;
  const window = nursingWindow(cfg, start, end);
  if (cfg.lifecycle.nursing && !window) return served;
  for (const child of [...children].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const original = starts.get(child.id), approach = youngArrivals.get(child.id);
    if (!original || !child.alive || child.lastEncounterAt === start || child.state !== 'resting'
      || !inCareContact(parent, child, cfg)) continue;
    // A young animal may arrive independently, but cannot consume before both routes finish.
    if (approach ? approach.parent !== child
      || child.currentGoal !== (cfg.lifecycle.nursing ? 'seek_nursing' : 'follow_parent')
      || !samePoint(child.position, approach.position) : child.patchId !== original.patchId || !samePoint(child.position, original.position)) continue;
    const budget = window ? nursingBudget(child, window.cycle) : null, policy = cfg.lifecycle.nursing;
    const arrival = Math.max(visit.arrival, approach?.arrival ?? start, window?.start ?? start, budget?.lastEnd ?? start);
    let seconds = Math.max(0, (window?.end ?? end) - arrival);
    if (budget && policy) {
      if (budget.completed) continue;
      seconds = Math.min(seconds, Math.max(0, policy.dailyContactSeconds - budget.contactSeconds));
    }
    if (!(seconds > 0)) continue;
    // A scheduled feed is to repletion (sim_0.36.0): the budget bounds contact time, not intake.
    const provided = provisionYoung(parent, child, cfg, seconds / 3600, undefined, arrival + seconds);
    if (provided.foodEquivalentKg <= 0 && provided.waterEquivalentL <= 0) continue;
    if (cfg.id === 'boar' && child.ageDays < (cfg.lifecycle.drinkFromDays ?? cfg.lifecycle.weanDays)
      && provided.waterEquivalentL > 0) child.lastMaternalWaterAt = arrival + seconds;
    if (budget && policy) {
      const daily = needsOf(child, cfg);
      budget.foodDays = budget.foodDays + provided.foodEquivalentKg / daily.foodKg;
      budget.waterDays = budget.waterDays + provided.waterEquivalentL / daily.waterL;
      budget.contactSeconds = Math.min(policy.dailyContactSeconds, budget.contactSeconds + seconds);
      budget.lastEnd = arrival + seconds;
      budget.completed = budget.contactSeconds >= policy.dailyContactSeconds - 1e-8
        || child.drives.hunger <= 1e-8 && child.drives.thirst <= 1e-8;
      child.nursingIntake = budget;
    }
    log.append({ type: 'provisioned', worldTime: Math.floor(arrival + seconds), simVersion: '',
      patchId: child.patchId, position: { ...child.position! }, actors: [child.id, parent.id], goal: 'care_for_young',
      conditions: { species: child.speciesId, lifeStage: child.lifeStage, source: 'parent_reserves',
        parentX: parent.position!.x, parentZ: parent.position!.z, contactRadiusM: careRadius(cfg),
        arrivalWorldTime: arrival, provisioningSeconds: seconds,
        ...(window ? { nursingCycle: window.cycle, schedule: 'daily_nursing' } : {}) },
      outcome: 'success', effects: provided,
      causalParents: [visit.routeId, approach?.routeId].filter((id): id is string => !!id), confidence: 'authoritative' });
    served.push(child.id);
  }
  return served;
}
