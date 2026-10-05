import { GRID_SIZE, PATCH_METRES, landWalkable, type Agent, type Patch, type SpeciesConfig } from '@vana/shared';

const PATCH_KM2 = (PATCH_METRES / 1000) ** 2;

/**
 * The patch radius whose diamond covers `km2`. A diamond of radius r holds 2r² + 2r + 1 patches.
 */
export function territoryRadiusPatches(km2: number): number {
  const patches = km2 / PATCH_KM2;
  return Math.max(1, Math.round((-2 + Math.sqrt(4 - 8 * (1 - patches))) / 4));
}

function holdsRanges(agent: Agent): boolean {
  return agent.alive
    && agent.dependentOn === null
    && (agent.lifeStage === 'subadult' || agent.lifeStage === 'adult' || agent.lifeStage === 'elder');
}

/** Older wins; between two of the same age the lower id does, so the answer never flickers. */
function outranks(a: Agent, b: Agent): boolean {
  return a.ageDays > b.ageDays || (a.ageDays === b.ageDays && a.id < b.id);
}

/**
 * True when an older animal of the same species and sex holds the range this one stands in.
 * Territorial predators are held to the density their ranges allow this way, not by starving:
 * without it tigers bred to a dozen in a forest with room for three or four.
 */
export function isFloater(
  agent: Agent,
  config: SpeciesConfig,
  rivals: readonly Agent[],
  patches: readonly Patch[],
): boolean {
  const territory = config.social.territory;
  if (territory === undefined || !holdsRanges(agent)) return false;
  if (config.social.structure === 'pack') return isPackFloater(agent, config, rivals, patches);

  const km2 = agent.sex === 'female' ? territory.femaleKm2 : territory.maleKm2;
  const radius = territoryRadiusPatches(km2);
  const here = patches[agent.patchId]!;

  for (const rival of rivals) {
    if (rival.id === agent.id || rival.sex !== agent.sex || !holdsRanges(rival)) continue;
    if (!outranks(rival, agent)) continue;
    const there = patches[rival.patchId]!;
    if (Math.abs(there.x - here.x) + Math.abs(there.y - here.y) <= radius) return true;
  }
  return false;
}

/**
 * sim_0.33.0: the share of a pack's range that is land it can actually hold. A mainland forest
 * is a window onto a larger landscape, so cells beyond the map count as range (the old rule,
 * unchanged). On an island the sea does not: a 40 km² dhole range centred on 12.24 km² of land
 * is mostly water. Cells are counted over the territory diamond around the pack's leader.
 */
export function packRangeLandFraction(config: SpeciesConfig, centre: Patch, patches: readonly Patch[]): number {
  const territory = config.social.territory;
  if (territory === undefined || centre.islandSeed === undefined) return 1;
  const radius = territoryRadiusPatches(territory.femaleKm2);
  let land = 0, cells = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > radius) continue;
      cells++;
      const x = centre.x + dx, y = centre.y + dy;
      if (x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE && landWalkable(patches[y * GRID_SIZE + x])) land++;
    }
  }
  return land / cells;
}

/**
 * How many adults one pack's range holds: the configured maximum pack for a full range, scaled
 * by the share of that range that is land, never below the smallest working pack (sim_0.33.0).
 * On the 12.24 km² island this is four dholes (0.33 adults/km², within the 0.35-0.9/km² of
 * Bandipur's core and above the 0.13 of Nagarahole); on the mainland it is unchanged.
 */
export function packCapacity(config: SpeciesConfig, centre: Patch, patches: readonly Patch[]): number {
  const [min, max] = config.social.groupSize;
  return Math.max(min, Math.round(max * packRangeLandFraction(config, centre, patches)));
}

/**
 * A pack holds its range together, against other packs. Two things make a pack animal a
 * floater: its own pack has grown past what one pack can be, and it is among the youngest; or
 * it stands in the range of a pack with an older leader. Without either, a pack only grew,
 * and packs multiplied in a forest smaller than one pack's range.
 */
function isPackFloater(
  agent: Agent,
  config: SpeciesConfig,
  rivals: readonly Agent[],
  patches: readonly Patch[],
): boolean {
  if (agent.groupId == null) return false;
  const territory = config.social.territory!;
  const radius = territoryRadiusPatches(territory.femaleKm2);
  const here = patches[agent.patchId]!;

  const leaders = new Map<string, Agent>();
  for (const member of [agent, ...rivals]) {
    if (member.groupId == null || !holdsRanges(member)) continue;
    const current = leaders.get(member.groupId);
    if (current === undefined || outranks(member, current)) leaders.set(member.groupId, member);
  }
  const ours = leaders.get(agent.groupId)!;

  let seniors = 0;
  for (const other of rivals) {
    if (other.id === agent.id || other.groupId == null || !holdsRanges(other)) continue;
    if (other.groupId === agent.groupId) {
      if (outranks(other, agent)) seniors++;
      continue;
    }
    if (!outranks(leaders.get(other.groupId)!, ours)) continue;
    const there = patches[other.patchId]!;
    if (Math.abs(there.x - here.x) + Math.abs(there.y - here.y) <= radius) return true;
  }
  return seniors >= packCapacity(config, patches[ours.patchId]!, patches);
}
