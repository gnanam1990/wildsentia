import { terrainCostFor, isWorldPosition, landWalkable, patchAtPosition, patchCentre, patchIdAt, treeAnchorForPatch, waterAccessPosition, type Agent, type HabitatType, type WorldGrid } from '@vana/shared';
import { canHunt, locomotionFactor, type World } from '@vana/sim';
import { WorldBusyError, type AnimalView, type PatchView, type SpeciesMotion, type WorldPort } from './liveLayer.js';
import { landRoute } from './route.js';

const view = (grid: WorldGrid, a: Agent): AnimalView => ({ id: a.id, speciesId: a.speciesId, alive: a.alive, controller: a.controller,
  position: { ...(a.position ?? { ...patchCentre(grid, a.patchId), heading: 0 }) }, patchId: a.patchId, state: a.state,
  lifeStage: a.lifeStage, drives: { ...a.drives }, ...(a.locomotionMode === 'submerged' ? { submerged: true } : {}) });

const inWorld = (grid: WorldGrid, x: number, z: number) => isWorldPosition(grid, { x, z, heading: 0 });

let indexed: { world: World; at: number; byPatch: Map<number, Agent[]> } | null = null;
/** Drops the cached index: for tests that move animals by hand between two calls. */
export function forgetPatchIndex(): void { indexed = null; }

/** Animals by the patch they stand in; agents' animals move, so it is rebuilt every half second. */
function patchIndex(w: World): Map<number, Agent[]> {
  const now = Date.now();
  if (indexed && indexed.world === w && now - indexed.at < 500) return indexed.byPatch;
  const byPatch = new Map<number, Agent[]>();
  for (const a of w.agents) {
    if (!a.alive) continue;
    const list = byPatch.get(a.patchId);
    if (list) list.push(a); else byPatch.set(a.patchId, [a]);
  }
  indexed = { world: w, at: now, byPatch };
  return byPatch;
}

/** The live layer's view of, and hands on, the running simulation. */
/** What only the host knows: where the observer is being shown each wild animal right now. */
export interface PlayedClock {
  position(id: string): { x: number; z: number; heading: number } | null;
  time(): number;
  /** World seconds per real second: the world clock's speed. */
  rate?(): number;
}

export { WorldBusyError } from './liveLayer.js';

export function worldPort(world: () => World, worldId: () => string | null, played?: PlayedClock, busy: () => boolean = () => false): WorldPort {
  const held = (): void => { if (busy()) throw new WorldBusyError(); };
  const patchAt = (x: number, z: number) => {
    const grid = world().grid;
    if (!inWorld(grid, x, z)) return null;
    const id = patchAtPosition(grid, { x, z, heading: 0 });
    return world().patches[id] ?? null;
  };
  return {
    busy,
    terrainProfile: () => world().terrainProfile,
    canHunt: (predatorId, preyId) => {
      const w = world(), predator = w.animal(predatorId), prey = w.animal(preyId);
      const predatorCfg = predator && w.species.get(predator.speciesId), preyCfg = prey && w.species.get(prey.speciesId);
      return !!(predatorCfg && preyCfg && prey && canHunt(predatorCfg, preyCfg, prey));
    },
    worldId,
    treeAt: (x, z) => {
      const p = patchAt(x, z);
      const anchor = p ? treeAnchorForPatch(world().grid, p) : null;
      return anchor ? { x: anchor.x, z: anchor.z } : null;
    },
    now: () => world().now(),
    worldRate: () => played?.rate?.() ?? 1,
    animal: (id) => { const a = world().animal(id); return a ? view(world().grid, a) : null; },
    species: (id): SpeciesMotion | null => {
      const cfg = world().species.get(id);
      if (!cfg) return null;
      const l = cfg.locomotion;
      return { displayName: cfg.displayName, walkMs: l.walkMs, trotMs: l.trotMs, sprintMs: l.sprintMs,
        sprintStaminaS: l.sprintStaminaS, predator: cfg.archetype === 'apex_predator' || cfg.archetype === 'pack_predator',
        preferredPrey: [...(cfg.hunting?.preferredPrey ?? [])], baseSuccess: cfg.hunting?.baseSuccess ?? 0,
        stalkConcealment: cfg.hunting?.stalkConcealment ?? 0, commitDistanceM: cfg.hunting?.commitDistanceM ?? 0,
        eatsMeat: cfg.diet.eats.some((e) => e.target === 'meat'),
        eatsPlants: cfg.diet.eats.some((e) => e.target === 'grass' || e.target === 'browse' || e.target === 'roots'), sightRangeM: cfg.senses.sightRangeM,
        detectionM: cfg.escape.detectionDistanceM, flightInitiationM: cfg.escape.flightInitiationM,
        evasiveness: cfg.escape.evasiveness, shoulderHeightM: cfg.body.shoulderHeightM,
        alarmSharing: cfg.social.alarmSharing === true, packHunter: cfg.archetype === 'pack_predator',
        climbs: cfg.locomotion.climbsTrees === true, flies: cfg.id === 'vulture' };
    },
    possessionBlock: (id) => world().possessionBlock(id),
    possess: (id, controller, opts) => { held(); return world().possess(id, controller, opts); },
    release: (id) => { held(); return world().release(id); },
    place: (id, position) => { held(); return world().placeControlled(id, position); },
    act: (id, action, seconds) => { held(); return world().applyControlledAction(id, action, seconds); },
    speedFactor: (id, x, z) => {
      const w = world(), agent = w.animal(id), patch = patchAt(x, z);
      const cfg = agent && w.species.get(agent.speciesId);
      if (!agent || !cfg || !patch) return 1;
      const cost = terrainCostFor(cfg, patch.habitat, patch.flooded === true);
      return locomotionFactor(agent, cfg) / Math.max(1, cost);
    },
    patchAt: (x, z): PatchView | null => {
      const p = patchAt(x, z);
      return p ? { id: p.id, habitat: p.habitat, grassKg: p.plant.grass + p.plant.browse, waterL: p.waterVolume, land: landWalkable(p) } : null;
    },
    nearby: (x, z, radius, limit) => {
      // Only the patches the circle touches, from an index rebuilt at most twice a second.
      const byPatch = patchIndex(world());
      // Each distance is worked out once, squared. Recomputing two hypotenuses per comparison
      // while sorting took half the server's time at 500 agents (load test, 5 October 2026):
      // the live layer asks this for every agent every second, and every observe asks again.
      const found: Array<{ d: number; a: Agent }> = [], r2 = radius * radius;
      const grid = world().grid;
      const span = Math.ceil(radius / grid.patchM) + 1, centre = inWorld(grid, x, z) ? patchAtPosition(grid, { x, z, heading: 0 }) : -1;
      if (centre < 0) return [];
      const cx = centre % grid.cols, cy = Math.floor(centre / grid.cols);
      for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
        const id = patchIdAt(grid, cx + dx, cy + dy);
        if (id === null) continue;
        for (const a of byPatch.get(id) ?? []) {
          // A diver under water is out of sight (Congo 1B).
          if (!a.alive || !a.position || a.locomotionMode === 'submerged') continue;
          const ox = a.position.x - x, oz = a.position.z - z, d = ox * ox + oz * oz;
          if (d <= r2) found.push({ d, a });
        }
      }
      return found.sort((p, q) => p.d - q.d).slice(0, limit).map((p) => view(grid, p.a));
    },
    waterPoints: (x, z, radius) => world().patches
      .filter((p) => landWalkable(p) && p.waterVolume > 0)
      .map((p) => ({ patchId: p.id, ...waterAccessPosition(world().grid, p.id, world().patches), litres: p.waterVolume }))
      .filter((w) => Math.hypot(w.x - x, w.z - z) <= radius)
      .map(({ patchId, x: wx, z: wz, litres }) => ({ patchId, x: wx, z: wz, litres })),
    route: (speciesId, from, to) => {
      const cfg = world().species.get(speciesId);
      return landRoute(world().grid, world().patches, from, to, (habitat) => cfg ? terrainCostFor(cfg, habitat as HabitatType) : 1);
    },
    candidates: (speciesId, limit) => world().possessionCandidates(speciesId, limit).map((a) => view(world().grid, a)),
    playedPosition: (id) => {
      const shown = played?.position(id);
      if (shown) return shown;
      const a = world().animal(id);
      return a?.alive && a.position ? { ...a.position } : null;
    },
    playedTime: () => played?.time() ?? world().now(),
    resolveHunt: (predatorId, preyId, at, time, killed) => { held(); return world().resolveLiveHunt(predatorId, preyId, at, time, killed) !== null; },
    feed: (id, seconds) => { held(); return world().feedControlled(id, seconds); },
    carcassNear: (x, z, radius) => {
      let best: { id: string; x: number; z: number } | null = null, bestGap = radius;
      for (const c of world().carcasses) {
        if (!c.position) continue;
        const gap = Math.hypot(c.position.x - x, c.position.z - z);
        if (gap <= bestGap) { bestGap = gap; best = { id: c.id, x: c.position.x, z: c.position.z }; }
      }
      return best;
    },
    placeWild: (id, position) => { held(); return world().placeWild(id, position); },
  };
}

/** A uniformly random walkable spot for a place drop, away from any water surface. */
export function randomLandSpot(world: World, random: () => number = Math.random): { x: number; z: number } | null {
  const land = world.patches.filter((p) => landWalkable(p));
  for (let attempt = 0; attempt < 200 && land.length; attempt++) {
    const patch = land[Math.floor(random() * land.length)]!, centre = patchCentre(world.grid, patch.id);
    const x = centre.x + (random() - 0.5) * (world.grid.patchM - 10), z = centre.z + (random() - 0.5) * (world.grid.patchM - 10);
    const at = patchAtPosition(world.grid, { x, z, heading: 0 });
    if (at !== patch.id) continue;
    const access = waterAccessPosition(world.grid, patch.id, world.patches);
    if (patch.waterVolume > 0 && Math.hypot(access.x - x, access.z - z) < 45) continue;
    return { x, z };
  }
  return null;
}
