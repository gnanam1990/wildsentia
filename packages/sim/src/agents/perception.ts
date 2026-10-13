import { edibleMass, landWalkable, patchCentre, patchIdAt, positionInPatch, type WorldGrid, type Agent, type Carcass, type Patch, type SpeciesConfig, type Season } from '@vana/shared';
import { confidenceOf } from './learning.js';
import { canEatMaternalCarcass, canFollowParent, needsOf, needsProvisioning } from './needs.js';

/** What the behaviour layer is allowed to ask the world. Agents never read global state. */
export interface WorldView {
  /** The world's patch lattice. */
  grid: WorldGrid;
  patches: Patch[];
  agentsInPatch(patchId: number): readonly Agent[];
  carcassesInPatch(patchId: number): readonly Carcass[];
  speciesOf(speciesId: string): SpeciesConfig;
  /** Production O(1) identity lookup; array-backed test views may omit it. */
  agentById?(id: string): Agent | undefined;
  /** The decision's world time, where the rule needs it (the held-kill check). */
  worldTime?: number;
  /** Congo 1B: the season, for flooding; absent in array-backed test views. */
  season?: Season;
  /** Where a group currently is, so a separated member can rejoin it. Null if the group is gone. */
  groupPatch(groupId: string): number | null;
}

export interface Percept {
  patch: Patch;
  neighbours: Patch[];
  bestFood: { patchId: number; kg: number } | null;
  bestWater: { patchId: number; litres: number } | null;
  /** Prey this predator would actually pursue, in the patch it can reach. */
  prey: Array<{ agent: Agent; patchId: number; herdSize: number }>;
  carrion: { carcass: Carcass; patchId: number } | null;
  /**
   * The most frightening predator of this species the animal detects (sim_0.34.0), with how far
   * off it is, what it is visibly doing and the fear it evokes now. Null when none is detected.
   */
  threat: { agent: Agent; patchId: number; distanceM: number; posture: ThreatPosture; fear: number } | null;
  /** Patches where a detected predator of this species stands: avoided unless desperate. */
  dangerous: ReadonlySet<number>;
  herdSize: number;
  /**
   * sim_0.37.0: for a hunter with a preferred prey size that perceives none of that size, the
   * patch within its range memory holding the most such prey, outside any patch where a predator
   * that hunts it stands; null when it perceives some, or knows of none.
   */
  preyRange?: number | null;
}

const edibleKg = (patch: Patch, species: SpeciesConfig): number => {
  let kg = 0;
  for (const item of species.diet.eats) {
    if (item.target === 'grass') kg += patch.plant.grass * item.preference;
    if (item.target === 'browse') kg += (patch.plant.browse
      + (patch.floweringGuild?.vegetativeKg ?? 0)) * item.preference;
    if (item.target === 'roots') kg += (patch.rooting?.kg ?? 0) * item.preference;
  }
  return kg;
};

const isPredator = (config: SpeciesConfig): boolean =>
  config.archetype === 'apex_predator' || config.archetype === 'pack_predator';

/**
 * Whether `prey` must keep away from `predator`: it is among the predator's prey, or (sim_0.37.0)
 * it avoids that predator, as leopards avoid tigers, without being its prey.
 */
export function threatens(predator: SpeciesConfig | undefined, prey: SpeciesConfig | undefined): boolean {
  if (!predator || !prey) return false;
  return (predator.hunting?.preferredPrey ?? []).includes(prey.id) || (prey.escape.avoids ?? []).includes(predator.id);
}

/**
 * Congo 1B: whether this predator may take this animal at all: its prey species, within the
 * weight it takes, at a life stage it takes, and within reach (on the ground, above water).
 * Every hunt checks it: the sim's own, a live agent's, and the world's record of a live kill.
 */
export function canHunt(predator: SpeciesConfig, prey: SpeciesConfig, animal: Pick<Agent, 'massKg' | 'lifeStage' | 'altitudeM' | 'locomotionMode'>): boolean {
  const hunting = predator.hunting;
  if (!hunting || !hunting.preferredPrey.includes(prey.id)) return false;
  if (animal.massKg > (hunting.maxPreyKg ?? Infinity)) return false;
  if (hunting.preyLifeStages && !hunting.preyLifeStages.includes(animal.lifeStage)) return false;
  return (animal.altitudeM ?? 0) <= 0 && animal.locomotionMode !== 'submerged';
}

/** What a predator is visibly doing, as prey can read it. */
export type ThreatPosture = 'hunting' | 'moving' | 'settled';

/** Past these the need outranks fear (selectGoal's desperation thresholds): a parched animal
 * drinks at a pool a predator stands by, as real ones do at shared waterholes. */
export const THIRST_DESPERATION = 0.72;
export const HUNGER_DESPERATION = 0.8;

/**
 * sim_0.34.0 landscape of fear. Before, prey registered only a predator in their own 300 m patch
 * and then gained 0.3 fear an hour against a 0.42/h decay, so they never fled before an attack
 * and grazed and drank beside resting tigers. Now prey detect predators that hunt them within
 * their own senses (the larger of sight and smell), across the patches they perceive:
 *
 * - hunting (its goal is to hunt): seen only within (1 - stalkConcealment) of that range, so a
 *   stalking tiger (0.72) is noticed by chital at about 45 m and a dhole pack (0.35) at about
 *   100 m. Once noticed it is the strongest threat: fear 0.6-1.0 by closeness, so the animal
 *   flees that same hour. Ambush still works because concealment hides the approach.
 * - moving: a predator walking in the open is seen at full range. Within the species' escape
 *   detection distance (chital 110 m, sambar 90 m, boar 70 m: the distance at which it reacts
 *   to an approaching predator) it sets fear 0.5-0.7 and the animal moves off; farther, 0.3-0.45,
 *   alert and keeping away.
 * - settled (resting, feeding, drinking): within the flight-initiation distance (chital 55 m,
 *   boar 25 m) fear 0.5, the animal steps away; farther, 0.2-0.4, vigilance without flight. The
 *   animal keeps foraging but avoids that predator's patch (`dangerous`).
 *
 * Chital, sambar and langur give loud alarm calls at tigers and leopards, and grazers keep a
 * flight-initiation distance (escape config); the numbers here are uncalibrated model policy.
 * Smell alone (a boar scents 450 m) tells an animal where a predator is, not that it must run.
 */
export function threatFear(posture: ThreatPosture, distanceM: number, rangeM: number,
  escape: { detectionDistanceM: number; flightInitiationM: number } = { detectionDistanceM: 0, flightInitiationM: 0 }): number {
  const closeness = (limit: number) => limit > 0 ? Math.max(0, Math.min(1, 1 - distanceM / limit)) : 1;
  if (posture === 'hunting') return 0.6 + 0.4 * closeness(rangeM);
  if (posture === 'moving') return distanceM <= escape.detectionDistanceM
    ? 0.5 + 0.2 * closeness(escape.detectionDistanceM) : 0.3 + 0.15 * closeness(rangeM);
  return distanceM <= escape.flightInitiationM ? 0.5 : 0.2 + 0.2 * closeness(rangeM);
}

export function threatPosture(predator: Agent): ThreatPosture {
  if (predator.currentGoal === 'hunt' || predator.state === 'stalking') return 'hunting';
  return predator.state === 'travelling' || predator.state === 'fleeing' ? 'moving' : 'settled';
}

const where = (grid: WorldGrid, agent: Agent) => positionInPatch(grid, agent.position, agent.patchId) ? agent.position! : patchCentre(grid, agent.patchId);

export const MAX_PERCEPTION_RADIUS = 8;

/**
 * A carcass something that hunts this animal has fed from within the past hour is that
 * predator's kill. The start-of-hour guard below only sees who stood in the patch then; a
 * tiger arriving at a dhole's kill in the same hour as four boar left them all eating
 * together at arm's length. (sim_0.31.0)
 */
export function heldByPredatorOf(carcass: Carcass, speciesId: string, worldTime: number, view: WorldView): boolean {
  return carcass.consumers.some((c) => {
    if (c.at < worldTime - 3600) return false;
    const eater = view.agentById?.(c.agentId);
    if (!eater?.alive || eater.speciesId === speciesId) return false;
    return threatens(view.speciesOf(eater.speciesId), view.speciesOf(speciesId));
  });
}

/**
 * sim_0.37.0: a kill cached in a tree (leopards) feeds only the animal that cached it and the
 * young that depend on her. Leopards haul kills into trees to keep them from kleptoparasites,
 * which cuts their losses sharply (Balme et al. 2017).
 */
export function canReachCarcass(carcass: Carcass, agent: Agent): boolean {
  return carcass.cachedBy === undefined || carcass.cachedBy === agent.id || agent.dependentOn === carcass.cachedBy;
}

/**
 * How far an animal knows its range beyond what it can sense: about two and a half kilometres.
 * Consulted only when nothing in view will do, so it guides an animal out of a grazed-bare or
 * dried-up stretch without making it walk past food it can see.
 */
export const RANGE_MEMORY_RADIUS = 8;

/** How far out to look for carrion before the scent test decides what is actually detectable. */
export const CARRION_SEARCH_RADIUS = 4;

/**
 * How many patches out a species can perceive, from the sense ranges in its config.
 *
 * A soaring vulture with two kilometres of sight covers far more ground than a tiger working
 * by scent through cover, and until this existed both saw exactly one patch in each direction —
 * which starved every wide-ranging forager in the world.
 */
export function perceptionRadius(grid: WorldGrid, config: SpeciesConfig): number {
  const reach = Math.max(config.senses.sightRangeM, config.senses.smellRangeM);
  return Math.min(MAX_PERCEPTION_RADIUS, Math.max(1, Math.round(reach / grid.patchM)));
}

function patchesWithin(grid: WorldGrid, patch: Patch, radius: number, patches: Patch[]): Patch[] {
  if (radius <= 1) return [patch, ...patch.neighbours.map((id) => patches[id]!)].filter(landWalkable);

  const found: Patch[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = patch.x + dx;
      const y = patch.y + dy;
      const id = patchIdAt(grid, x, y);
      if (id === null) continue;
      if (Math.abs(dx) + Math.abs(dy) > radius) continue;
      found.push(patches[id]!);
    }
  }
  return found.filter(landWalkable);
}

/**
 * Agents see their own patch and its immediate neighbours, never the whole world. Everything
 * downstream — goal scores, hunts, flight — is computed from this limited view.
 */
export function perceive(agent: Agent, species: SpeciesConfig, view: WorldView): Percept {
  const patch = view.patches[agent.patchId]!;
  const neighbours = patch.neighbours.map((id) => view.patches[id]!).filter(landWalkable);
  const visible = patchesWithin(view.grid, patch, perceptionRadius(view.grid, species), view.patches);

  let bestFood: Percept['bestFood'] = null;
  let bestWater: Percept['bestWater'] = null;
  let carrion: Percept['carrion'] = null;
  let threat: Percept['threat'] = null;
  const dangerous = new Set<number>();
  const prey: Percept['prey'] = [];

  const wantsMeat = species.hunting !== undefined;
  const preferred = new Set(species.hunting?.preferredPrey ?? []);

  // Detect first, so food and water choices can keep away from what was detected.
  const here = where(view.grid, agent);
  const senseM = Math.max(species.senses.sightRangeM, species.senses.smellRangeM);
  for (const p of visible) {
    for (const other of view.agentsInPatch(p.id)) {
      if (!other.alive || other.id === agent.id) continue;
      const otherSpecies = view.speciesOf(other.speciesId);
      if (!isPredator(otherSpecies) || !threatens(otherSpecies, species)) continue;
      const posture = threatPosture(other);
      const rangeM = posture === 'hunting' ? senseM * (1 - (otherSpecies.hunting?.stalkConcealment ?? 0)) : senseM;
      const at = where(view.grid, other), distanceM = Math.hypot(at.x - here.x, at.z - here.z);
      if (distanceM > rangeM) continue;
      dangerous.add(p.id);
      const fear = threatFear(posture, distanceM, rangeM, species.escape);
      if (threat === null || fear > threat.fear) threat = { agent: other, patchId: p.id, distanceM, posture, fear };
    }
  }
  const thirsty = agent.drives.thirst >= THIRST_DESPERATION, starving = agent.drives.hunger >= HUNGER_DESPERATION;

  for (const p of visible) {
    const kg = edibleKg(p, species);
    if (kg > 0 && (starving || !dangerous.has(p.id)) && (bestFood === null || kg > bestFood.kg)) bestFood = { patchId: p.id, kg };
    if (p.waterVolume > 0 && (thirsty || !dangerous.has(p.id)) && (bestWater === null || p.waterVolume > bestWater.litres)) {
      bestWater = { patchId: p.id, litres: p.waterVolume };
    }

    const occupants = view.agentsInPatch(p.id);

    if (wantsMeat) {
      const bySpecies = new Map<string, number>();
      for (const other of occupants) {
        if (!other.alive) continue;
        bySpecies.set(other.speciesId, (bySpecies.get(other.speciesId) ?? 0) + 1);
      }
      for (const other of occupants) {
        // The current hunt solver is planar: it cannot make physical contact with an
        // animal on an exact tree anchor above ground. No general invulnerability is implied.
        if (!other.alive || other.id === agent.id || !preferred.has(other.speciesId)
          || (other.altitudeM ?? 0) > 0 || other.locomotionMode === 'submerged') continue;
        // sim_0.37.0 intraguild avoidance: a hunter does not hunt where a predator that hunts it
        // stands (leopards keep away from tigers), unless it is starving.
        if (dangerous.has(p.id) && !starving) continue;
        // sim_0.37.0: prey heavier than the hunter will take (an adult sambar for a leopard).
        if (other.massKg > (species.hunting?.maxPreyKg ?? Infinity)) continue;
        // Congo 1B: only the life stages it takes (no island species names any).
        if (species.hunting?.preyLifeStages && !species.hunting.preyLifeStages.includes(other.lifeStage)) continue;
        // An agent-steered animal is hunted in real time by the live layer, not by the
        // hourly solver, which cannot know where its agent will take it.
        if (other.controller) continue;
        prey.push({ agent: other, patchId: p.id, herdSize: bySpecies.get(other.speciesId) ?? 1 });
      }
    }

  }

  // Range memory. Gaur see three hundred metres; in the dry season they grazed their
  // surroundings bare and starved walking in circles with pasture two kilometres off, and
  // elephants died of thirst beside a lake they could not see. Animals know their range better
  // than their senses reach, so when nothing in view will do they head for what they remember.
  const needs = needsOf(agent, species);
  const dailyNeed = Math.max(needs.foodKg, 0.05);
  const waterNeed = Math.max(needs.waterL, 0.05);
  // sim_0.37.0: a mother of young that cannot yet follow her looks for food only within her senses
  // of where she is, unless she is starving, as she only idles within reach of them (sim_0.32.0).
  // On island_v2 a food-limited sow walked 900 m to dig while her 9-day piglets, in the nest,
  // died of thirst, and a leopardess hunting from memory left her 57-day cub 480 m behind.
  // Leopard mothers leave cubs hidden for up to 36 hours (Animal Diversity Web), not for days.
  const tethered = !starving && agent.offspringIds.some(id => {
    const child = view.agentById?.(id);
    return child?.alive === true && child.dependentOn === agent.id && needsProvisioning(child, species) && !canFollowParent(child, species);
  });
  const grazes = species.diet.eats.some((e) => e.target === 'grass' || e.target === 'browse' || e.target === 'roots');
  const needFood = grazes && (bestFood === null || bestFood.kg < dailyNeed);
  const needWater = bestWater === null || bestWater.litres < waterNeed;
  //
  // How far it remembers water depends on what it was taught. At neutral confidence this is
  // the full range; an orphan left at its innate floor knows only the water close by.
  if (needFood || needWater) {
    const waterReach = Math.min(RANGE_MEMORY_RADIUS, Math.max(2,
      Math.round(2 + 12 * confidenceOf(agent, species, 'water_locations'))));
    // The tether limits only where she looks for food: she still remembers water as far as any
    // animal does. Limiting both left a thirsty, food-limited sow on island_v2 blind to water
    // past her senses (two patches); she grazed 400-950 m from the nest at thirst 0.7-0.86, too
    // thirsty to nurse, and her 9-day piglets died of thirst.
    const foodReach = tethered ? perceptionRadius(view.grid, species) : RANGE_MEMORY_RADIUS;
    const reach = needFood ? Math.max(tethered && needWater ? waterReach : 0, foodReach) : waterReach;
    for (const p of patchesWithin(view.grid, patch, reach, view.patches)) {
      if (dangerous.has(p.id) && !(needFood ? starving : thirsty)) continue;
      const steps = Math.abs(p.x - patch.x) + Math.abs(p.y - patch.y);
      if (needFood && steps <= foodReach) {
        const kg = edibleKg(p, species);
        if (kg > (bestFood?.kg ?? 0)) bestFood = { patchId: p.id, kg };
      }
      if (needWater && steps <= waterReach && p.waterVolume > (bestWater?.litres ?? 0)) {
        bestWater = { patchId: p.id, litres: p.waterVolume };
      }
    }
  }

  // Carrion is found by smell, and a carcass carries its own scent radius: a dead gaur is
  // detectable much further off than a dead hare. Searching only the patches an animal can see
  // meant a predator walked away from a kill it had barely touched and killed again the next
  // day, which is where most of the world's dead animals were going.
  //
  // Which one is worth walking to depends on distance as well as size. Past a couple of days'
  // food, more meat is no reason to go further: choosing by size alone sent a pack eating one
  // carcass across to the next the moment theirs held a few kilograms less, then back again,
  // so they walked instead of eating and starved beside carrion they never reached.
  //
  // Or by sight. A vulture smells almost nothing and sees for two kilometres from the air;
  // found by scent alone, it found only what it stood beside and starved over country full
  // of carcasses.
  if (species.diet.canScavenge) {
    const sightPatches = Math.round(species.senses.sightRangeM / view.grid.patchM);
    const reach = Math.min(MAX_PERCEPTION_RADIUS, Math.max(CARRION_SEARCH_RADIUS, sightPatches));
    const enough = dailyNeed * 2;
    let bestWorth = 0;
    // sim_0.37.0: a young that cannot yet follow its mother eats her kills only where it lies. A
    // leopard's cubs eat meat from six to eight weeks, when they begin to leave the den (Animal
    // Diversity Web), two weeks before they follow her; on island_v2 a 54-day cub walked 930 m
    // alone to a cached kill, splitting the litter, and its mother, shuttling between the two,
    // let both halves die of thirst. (A tiger's cubs follow before they eat meat.)
    const lies = needsProvisioning(agent, species) && !canFollowParent(agent, species);
    for (const p of patchesWithin(view.grid, patch, reach, view.patches)) {
      if (lies && p.id !== patch.id) continue;
      const steps = Math.abs(p.x - patch.x) + Math.abs(p.y - patch.y);
      const distanceM = steps * view.grid.patchM;
      // Nothing walks up to a carcass something that hunts it is standing over. Without this
      // boar took two-thirds of every tiger kill, and tigers killed three times as often.
      const guarded = view.agentsInPatch(p.id).some((other) =>
        other.alive && other.id !== agent.id
        && threatens(view.speciesOf(other.speciesId), species));
      if (guarded) continue;
      for (const candidate of view.carcassesInPatch(p.id)) {
        if (needsProvisioning(agent, species)
          && !canEatMaternalCarcass(agent, species, candidate, view)) continue;
        if (view.worldTime !== undefined && heldByPredatorOf(candidate, agent.speciesId, view.worldTime, view)) continue;
        if (!canReachCarcass(candidate, agent)) continue;
        const smelt = distanceM <= candidate.scentRadiusM + species.senses.smellRangeM;
        const seen = distanceM <= species.senses.sightRangeM;
        if (!smelt && !seen) continue;
        const edible = edibleMass(candidate.biomass);
        const worth = Math.min(edible, enough) / (1 + steps);
        if (worth <= bestWorth) continue;
        bestWorth = worth;
        carrion = { carcass: candidate, patchId: p.id };
      }
    }
  }

  const herdSize = view
    .agentsInPatch(agent.patchId)
    .reduce((n, other) => n + (other.alive && other.speciesId === agent.speciesId ? 1 : 0), 0);

  // sim_0.37.0: range memory for a hunter of medium prey. A leopard knows where the deer and pigs
  // of its range graze, as grazers know where their pasture is. On island_v2 leopards that saw only
  // hares for days (in grassland where no deer stood within 300 m) walked from hare patch to hare
  // patch at random and starved. Leopards patrol their ranges and revisit places where prey gather.
  let preyRange: number | null = null;
  const sized = species.hunting?.preferredPreyKg;
  if (sized && !tethered && !prey.some(p => p.agent.massKg >= sized[0])) {
    let best = 0;
    for (const p of patchesWithin(view.grid, patch, RANGE_MEMORY_RADIUS, view.patches)) {
      if (dangerous.has(p.id) || p.id === patch.id) continue;
      let count = 0;
      for (const other of view.agentsInPatch(p.id)) if (other.alive && preferred.has(other.speciesId) && (other.altitudeM ?? 0) === 0
        && other.massKg >= sized[0] && other.massKg <= (species.hunting?.maxPreyKg ?? Infinity)) count++;
      if (count > best) { best = count; preyRange = p.id; }
    }
  }

  return { patch, neighbours, bestFood, bestWater, prey, carrion, threat, dangerous, herdSize, ...(sized ? { preyRange } : {}) };
}
