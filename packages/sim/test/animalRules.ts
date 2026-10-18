import { CONGO_GRID, atWaterAccess, fliesSpecies, inCongoChannel, positionInPatch, treeAnchorGeometry,
  type Agent, type Patch, type SpeciesConfig, type WorldGrid } from '@vana/shared';

/**
 * The Congo's animals, as they should be (docs/2026-10-17-congo-animal-rules.md): each rule is a
 * check of one living animal at an hour's end, true when the animal keeps it.
 */
export interface RuleWorld { grid: WorldGrid; patches: Patch[]; species: ReadonlyMap<string, SpeciesConfig>; seed: number; parents: ReadonlySet<string> }
export interface Rule { id: string; text: string; applies: (a: Agent, cfg: SpeciesConfig, w: RuleWorld) => boolean; holds: (a: Agent, cfg: SpeciesConfig, w: RuleWorld) => boolean }

/** A bird flying over the Congo's forest is above its 44 m emergents. */
export const FLIGHT_CLEARANCE_M = 55;

const altitude = (a: Agent) => a.altitudeM ?? 0;
const climbs = (cfg: SpeciesConfig) => cfg.locomotion.climbsTrees === true;
const swims = (cfg: SpeciesConfig) => cfg.locomotion.swims !== undefined;
/** Crosses a river's channel: swims, or wades it as an elephant or a red river hog does (water costs it under 3). */
const crossesRivers = (cfg: SpeciesConfig) => swims(cfg) || (cfg.locomotion.terrainCost.water ?? Infinity) < 3;
const atTrunk = (a: Agent, w: RuleWorld) => {
  const tree = treeAnchorGeometry(w.grid, a.patchId);
  return tree !== null && a.treeAnchorId === tree.id && Math.hypot(a.position!.x - tree.x, a.position!.z - tree.z) <= 1e-6;
};
const inChannel = (a: Agent, w: RuleWorld) => inCongoChannel(w.grid, w.seed, a.position!.x, a.position!.z);

export const RULES: readonly Rule[] = [
  { id: 'placed', text: 'Every animal stands inside its own patch.',
    applies: () => true, holds: (a, _c, w) => a.position !== undefined && positionInPatch(w.grid, a.position, a.patchId) },
  { id: 'grounded', text: 'An animal that neither flies nor climbs is on the ground (or under water if it dives).',
    applies: (_a, c) => !fliesSpecies(c) && !climbs(c), holds: (a) => altitude(a) === 0 },
  { id: 'climber-in-tree', text: 'A climber off the ground is up its patch\'s tree, at the trunk, no higher than it climbs.',
    applies: (a, c) => climbs(c) && !fliesSpecies(c) && altitude(a) > 0,
    holds: (a, c, w) => a.locomotionMode === 'climb' && atTrunk(a, w)
      && altitude(a) <= Math.min(treeAnchorGeometry(w.grid, a.patchId)!.climbHeightM, c.locomotion.climbHeightM ?? Infinity) + 1e-9 },
  { id: 'bird-perch', text: 'A bird resting off the ground sits on top of a crown, not inside its leaves.',
    applies: (a, c) => fliesSpecies(c) && a.locomotionMode === 'climb',
    holds: (a, _c, w) => atTrunk(a, w) && Math.abs(altitude(a) - treeAnchorGeometry(w.grid, a.patchId)!.perchHeightM) <= 1e-9 },
  { id: 'bird-flight', text: 'A bird still in flight at the hour\'s end is above the canopy.',
    applies: (a, c) => fliesSpecies(c) && a.locomotionMode === 'flight', holds: (a) => altitude(a) >= FLIGHT_CLEARANCE_M - 1e-9 },
  { id: 'bird-off-floor', text: 'A grown bird is on the forest floor only at a kill, to feed or to drink: it rests and lands in the trees. (Nests are not built yet: a chick, its parent caring for it, and a female about to lay stay where the family routine puts them.)',
    applies: (a, c, w) => fliesSpecies(c) && a.dependentOn === null && a.pregnantSince === null && !w.parents.has(a.id)
      && !['hunt', 'care_for_young', 'find_water', 'find_food', 'scavenge'].includes(a.currentGoal) && a.state !== 'feeding' && a.state !== 'drinking',
    holds: (a) => altitude(a) > 0 },
  { id: 'dry-feet', text: 'An animal that does not cross rivers keeps out of a river\'s channel, except to drink at its patch\'s drinking point and rest there after.',
    applies: (a, c) => !crossesRivers(c) && altitude(a) === 0 && a.state !== 'dead',
    holds: (a, _c, w) => !inChannel(a, w) || atWaterAccess(w.grid, a.position!, a.patchId, w.patches) },
  { id: 'diver-in-water', text: 'An animal under water is a diver, in a river channel or a flooded patch.',
    applies: (a) => a.locomotionMode === 'submerged',
    holds: (a, c, w) => swims(c) && (inChannel(a, w) || w.patches[a.patchId]!.flooded === true || w.patches[a.patchId]!.habitat === 'water') },
  { id: 'drinks-at-water', text: 'An animal drinking stands at water: its patch\'s pool or a river.',
    applies: (a) => a.state === 'drinking',
    holds: (a, _c, w) => atWaterAccess(w.grid, a.position!, a.patchId, w.patches) || inChannel(a, w) },
  { id: 'canopy-feeding', text: 'Only a canopy dweller feeds up in a tree.',
    applies: (a) => a.state === 'grazing' && altitude(a) > 0, holds: (_a, c) => c.locomotion.canopyDweller === true },
];

/** Breaks of each rule by species, over the living animals now. */
export function checkRules(agents: readonly Agent[], w: RuleWorld, tally = new Map<string, number>(), seen = new Map<string, number>()):
  { breaks: Map<string, number>; checked: Map<string, number> } {
  for (const a of agents) {
    if (!a.alive) continue;
    const cfg = w.species.get(a.speciesId)!;
    for (const rule of RULES) {
      if (!rule.applies(a, cfg, w)) continue;
      const key = `${rule.id}:${a.speciesId}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (!rule.holds(a, cfg, w)) tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  return { breaks: tally, checked: seen };
}

export const CONGO = CONGO_GRID;
