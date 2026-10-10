import { landWalkable, patchAtPosition, patchCentre, treeAnchorForPatch, waterAccessPosition, GRID_SIZE, PATCH_METRES, type Agent } from '@vana/shared';
import { locomotionFactor, type World } from '@vana/sim';
import type { AnimalView, PatchView, SpeciesMotion, WorldPort } from './liveLayer.js';
import { landRoute } from './route.js';

const view = (a: Agent): AnimalView => ({ id: a.id, speciesId: a.speciesId, alive: a.alive, controller: a.controller,
  position: { ...(a.position ?? { ...patchCentre(a.patchId), heading: 0 }) }, patchId: a.patchId, state: a.state,
  lifeStage: a.lifeStage, drives: { ...a.drives } });

const inWorld = (x: number, z: number) => {
  const edge = GRID_SIZE * PATCH_METRES - PATCH_METRES / 2;
  return Number.isFinite(x) && Number.isFinite(z) && x >= -PATCH_METRES / 2 && z >= -PATCH_METRES / 2 && x < edge && z < edge;
};

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

export function worldPort(world: () => World, worldId: () => string | null, played?: PlayedClock): WorldPort {
  const patchAt = (x: number, z: number) => {
    if (!inWorld(x, z)) return null;
    const id = patchAtPosition({ x, z, heading: 0 });
    return world().patches[id] ?? null;
  };
  return {
    worldId,
    treeAt: (x, z) => {
      const p = patchAt(x, z);
      const anchor = p ? treeAnchorForPatch(p) : null;
      return anchor ? { x: anchor.x, z: anchor.z } : null;
    },
    now: () => world().now(),
    worldRate: () => played?.rate?.() ?? 1,
    animal: (id) => { const a = world().animal(id); return a ? view(a) : null; },
    species: (id): SpeciesMotion | null => {
      const cfg = world().species.get(id);
      if (!cfg) return null;
      const l = cfg.locomotion;
      return { displayName: cfg.displayName, walkMs: l.walkMs, trotMs: l.trotMs, sprintMs: l.sprintMs,
        sprintStaminaS: l.sprintStaminaS, predator: cfg.archetype === 'apex_predator' || cfg.archetype === 'pack_predator',
        preferredPrey: [...(cfg.hunting?.preferredPrey ?? [])], baseSuccess: cfg.hunting?.baseSuccess ?? 0,
        stalkConcealment: cfg.hunting?.stalkConcealment ?? 0, commitDistanceM: cfg.hunting?.commitDistanceM ?? 0,
        eatsMeat: cfg.diet.eats.some((e) => e.target === 'meat'), sightRangeM: cfg.senses.sightRangeM,
        detectionM: cfg.escape.detectionDistanceM, flightInitiationM: cfg.escape.flightInitiationM,
        evasiveness: cfg.escape.evasiveness, shoulderHeightM: cfg.body.shoulderHeightM,
        alarmSharing: cfg.social.alarmSharing === true, packHunter: cfg.archetype === 'pack_predator',
        climbs: cfg.locomotion.climbsTrees === true, flies: cfg.id === 'vulture' };
    },
    possessionBlock: (id) => world().possessionBlock(id),
    possess: (id, controller) => world().possess(id, controller),
    release: (id) => world().release(id),
    place: (id, position) => world().placeControlled(id, position),
    act: (id, action, seconds) => world().applyControlledAction(id, action, seconds),
    speedFactor: (id, x, z) => {
      const w = world(), agent = w.animal(id), patch = patchAt(x, z);
      const cfg = agent && w.species.get(agent.speciesId);
      if (!agent || !cfg || !patch) return 1;
      const cost = cfg.locomotion.terrainCost[patch.habitat as keyof typeof cfg.locomotion.terrainCost] ?? 1;
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
      const span = Math.ceil(radius / PATCH_METRES) + 1, centre = inWorld(x, z) ? patchAtPosition({ x, z, heading: 0 }) : -1;
      if (centre < 0) return [];
      const cx = centre % GRID_SIZE, cy = Math.floor(centre / GRID_SIZE);
      for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
        const px = cx + dx, py = cy + dy;
        if (px < 0 || py < 0 || px >= GRID_SIZE || py >= GRID_SIZE) continue;
        for (const a of byPatch.get(py * GRID_SIZE + px) ?? []) {
          if (!a.alive || !a.position) continue;
          const ox = a.position.x - x, oz = a.position.z - z, d = ox * ox + oz * oz;
          if (d <= r2) found.push({ d, a });
        }
      }
      return found.sort((p, q) => p.d - q.d).slice(0, limit).map((p) => view(p.a));
    },
    waterPoints: (x, z, radius) => world().patches
      .filter((p) => landWalkable(p) && p.waterVolume > 0)
      .map((p) => ({ patchId: p.id, ...waterAccessPosition(p.id), litres: p.waterVolume }))
      .filter((w) => Math.hypot(w.x - x, w.z - z) <= radius)
      .map(({ patchId, x: wx, z: wz, litres }) => ({ patchId, x: wx, z: wz, litres })),
    route: (speciesId, from, to) => {
      const cfg = world().species.get(speciesId);
      const costs = cfg?.locomotion.terrainCost as Record<string, number> | undefined;
      return landRoute(world().patches, from, to, (habitat) => costs?.[habitat] ?? 1);
    },
    candidates: (speciesId, limit) => world().possessionCandidates(speciesId, limit).map(view),
    playedPosition: (id) => {
      const shown = played?.position(id);
      if (shown) return shown;
      const a = world().animal(id);
      return a?.alive && a.position ? { ...a.position } : null;
    },
    playedTime: () => played?.time() ?? world().now(),
    resolveHunt: (predatorId, preyId, at, time, killed) => world().resolveLiveHunt(predatorId, preyId, at, time, killed) !== null,
    feed: (id, seconds) => world().feedControlled(id, seconds),
    carcassNear: (x, z, radius) => {
      let best: { id: string; x: number; z: number } | null = null, bestGap = radius;
      for (const c of world().carcasses) {
        if (!c.position) continue;
        const gap = Math.hypot(c.position.x - x, c.position.z - z);
        if (gap <= bestGap) { bestGap = gap; best = { id: c.id, x: c.position.x, z: c.position.z }; }
      }
      return best;
    },
    placeWild: (id, position) => world().placeWild(id, position),
  };
}

/** A uniformly random walkable spot for a place drop, away from any water surface. */
export function randomLandSpot(world: World, random: () => number = Math.random): { x: number; z: number } | null {
  const land = world.patches.filter((p) => landWalkable(p));
  for (let attempt = 0; attempt < 200 && land.length; attempt++) {
    const patch = land[Math.floor(random() * land.length)]!, centre = patchCentre(patch.id);
    const x = centre.x + (random() - 0.5) * (PATCH_METRES - 10), z = centre.z + (random() - 0.5) * (PATCH_METRES - 10);
    const at = patchAtPosition({ x, z, heading: 0 });
    if (at !== patch.id) continue;
    const access = waterAccessPosition(patch.id);
    if (patch.waterVolume > 0 && Math.hypot(access.x - x, access.z - z) < 45) continue;
    return { x, z };
  }
  return null;
}
