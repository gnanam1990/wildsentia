import { landWalkable, patchAtPosition, patchCentre, waterAccessPosition, GRID_SIZE, PATCH_METRES, type Agent } from '@vana/shared';
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

/** The live layer's view of, and hands on, the running simulation. */
export function worldPort(world: () => World, worldId: () => string | null): WorldPort {
  const patchAt = (x: number, z: number) => {
    if (!inWorld(x, z)) return null;
    const id = patchAtPosition({ x, z, heading: 0 });
    return world().patches[id] ?? null;
  };
  return {
    worldId,
    now: () => world().now(),
    animal: (id) => { const a = world().animal(id); return a ? view(a) : null; },
    species: (id): SpeciesMotion | null => {
      const cfg = world().species.get(id);
      if (!cfg) return null;
      const l = cfg.locomotion;
      return { displayName: cfg.displayName, walkMs: l.walkMs, trotMs: l.trotMs, sprintMs: l.sprintMs,
        sprintStaminaS: l.sprintStaminaS, predator: cfg.archetype === 'apex_predator' || cfg.archetype === 'pack_predator' };
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
    nearby: (x, z, radius, limit) => world().agents
      .filter((a) => a.alive && a.position && Math.hypot(a.position.x - x, a.position.z - z) <= radius)
      .sort((a, b) => Math.hypot(a.position!.x - x, a.position!.z - z) - Math.hypot(b.position!.x - x, b.position!.z - z))
      .slice(0, limit).map(view),
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
    candidates: (speciesId, limit) => {
      const w = world();
      return w.agents.filter((a) => (speciesId === null || a.speciesId === speciesId) && w.possessionBlock(a.id) === null)
        .slice(0, limit).map(view);
    },
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
