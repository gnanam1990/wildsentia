import { GRID_SIZE, PATCH_METRES, edibleMass, landWalkable, type Agent, type Carcass, type Patch, type SpeciesConfig } from '@vana/shared';
import { confidenceOf } from './learning.js';
import { canEatMaternalCarcass, needsOf, needsProvisioning } from './needs.js';

/** What the behaviour layer is allowed to ask the world. Agents never read global state. */
export interface WorldView {
  patches: Patch[];
  agentsInPatch(patchId: number): readonly Agent[];
  carcassesInPatch(patchId: number): readonly Carcass[];
  speciesOf(speciesId: string): SpeciesConfig;
  /** Production O(1) identity lookup; array-backed test views may omit it. */
  agentById?(id: string): Agent | undefined;
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
  /** A predator close enough to matter. Drives fear and flight. */
  threat: { agent: Agent; patchId: number } | null;
  herdSize: number;
}

const edibleKg = (patch: Patch, species: SpeciesConfig): number => {
  let kg = 0;
  for (const item of species.diet.eats) {
    if (item.target === 'grass') kg += patch.plant.grass * item.preference;
    if (item.target === 'browse') kg += (patch.plant.browse
      + (patch.floweringGuild?.vegetativeKg ?? 0)) * item.preference;
  }
  return kg;
};

const isPredator = (config: SpeciesConfig): boolean =>
  config.archetype === 'apex_predator' || config.archetype === 'pack_predator';

export const MAX_PERCEPTION_RADIUS = 8;

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
export function perceptionRadius(config: SpeciesConfig): number {
  const reach = Math.max(config.senses.sightRangeM, config.senses.smellRangeM);
  return Math.min(MAX_PERCEPTION_RADIUS, Math.max(1, Math.round(reach / PATCH_METRES)));
}

function patchesWithin(patch: Patch, radius: number, patches: Patch[]): Patch[] {
  if (radius <= 1) return [patch, ...patch.neighbours.map((id) => patches[id]!)].filter(landWalkable);

  const found: Patch[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = patch.x + dx;
      const y = patch.y + dy;
      if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) continue;
      if (Math.abs(dx) + Math.abs(dy) > radius) continue;
      found.push(patches[y * GRID_SIZE + x]!);
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
  const visible = patchesWithin(patch, perceptionRadius(species), view.patches);

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
          || (other.altitudeM ?? 0) > 0) continue;
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

  // Range memory. Gaur see three hundred metres; in the dry season they grazed their
  // surroundings bare and starved walking in circles with pasture two kilometres off, and
  // elephants died of thirst beside a lake they could not see. Animals know their range better
  // than their senses reach, so when nothing in view will do they head for what they remember.
  const needs = needsOf(agent, species);
  const dailyNeed = Math.max(needs.foodKg, 0.05);
  const waterNeed = Math.max(needs.waterL, 0.05);
  const grazes = species.diet.eats.some((e) => e.target === 'grass' || e.target === 'browse');
  const needFood = grazes && (bestFood === null || bestFood.kg < dailyNeed);
  const needWater = bestWater === null || bestWater.litres < waterNeed;
  //
  // How far it remembers water depends on what it was taught. At neutral confidence this is
  // the full range; an orphan left at its innate floor knows only the water close by.
  if (needFood || needWater) {
    const waterReach = Math.min(RANGE_MEMORY_RADIUS, Math.max(2,
      Math.round(2 + 12 * confidenceOf(agent, species, 'water_locations'))));
    const reach = needFood ? RANGE_MEMORY_RADIUS : waterReach;
    for (const p of patchesWithin(patch, reach, view.patches)) {
      if (needFood) {
        const kg = edibleKg(p, species);
        if (kg > (bestFood?.kg ?? 0)) bestFood = { patchId: p.id, kg };
      }
      const steps = Math.abs(p.x - patch.x) + Math.abs(p.y - patch.y);
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
    const sightPatches = Math.round(species.senses.sightRangeM / PATCH_METRES);
    const reach = Math.min(MAX_PERCEPTION_RADIUS, Math.max(CARRION_SEARCH_RADIUS, sightPatches));
    const enough = dailyNeed * 2;
    let bestWorth = 0;
    for (const p of patchesWithin(patch, reach, view.patches)) {
      const steps = Math.abs(p.x - patch.x) + Math.abs(p.y - patch.y);
      const distanceM = steps * PATCH_METRES;
      // Nothing walks up to a carcass something that hunts it is standing over. Without this
      // boar took two-thirds of every tiger kill, and tigers killed three times as often.
      const guarded = view.agentsInPatch(p.id).some((other) =>
        other.alive && other.id !== agent.id
        && (view.speciesOf(other.speciesId).hunting?.preferredPrey ?? []).includes(agent.speciesId));
      if (guarded) continue;
      for (const candidate of view.carcassesInPatch(p.id)) {
        if (needsProvisioning(agent, species)
          && !canEatMaternalCarcass(agent, species, candidate, view)) continue;
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

  return { patch, neighbours, bestFood, bestWater, prey, carrion, threat, herdSize };
}
