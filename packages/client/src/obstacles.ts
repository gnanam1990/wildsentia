import type { PlacedPlant } from './vegetation.js';

/**
 * Trunks and boulders an animal should walk around, not through.
 *
 * The simulation routes animals in straight segments between points; it does not know where
 * the observer draws each tree or rock, because those are placed here from canopy and habitat.
 * So a recorded walk could pass straight through a trunk. Near the camera the drawn position
 * is pushed out to the obstacle's edge, and the animal slides round it and carries on. Only
 * where it is drawn changes; its recorded route and everything the simulation decides stay.
 */
export interface Obstacle { x: number; z: number; radius: number }

/** Footprint radius per unit of placement scale, from the packaged models. */
const FOOTPRINT: Record<string, number> = {
  CommonTree_1: 0.3, CommonTree_4: 0.3, TwistedTree_1: 0.3,      // Spreading broadleaf trunk.
  CommonTree_2: 0.22, CommonTree_3: 0.22, TwistedTree_3: 0.22,   // Upright broadleaf trunk.
  DeadTree_2: 0.3,
  Rock_Medium_1: 1.0, Rock_Medium_2: 1.1, Rock_Medium_3: 1.0, Boulder_Large: 1.0,
};
/** Anything narrower is stepped over: pebbles, saplings. */
const MIN_RADIUS_M = 0.25;
const CELL_M = 8;

export function obstaclesFrom(plan: ReadonlyMap<string, readonly PlacedPlant[]>): Obstacle[] {
  const result: Obstacle[] = [];
  for (const [kind, items] of plan) {
    const perScale = FOOTPRINT[kind];
    if (perScale === undefined) continue;
    for (const item of items) {
      const radius = perScale * item.scale;
      if (radius >= MIN_RADIUS_M) result.push({ x: item.x, z: item.z, radius });
    }
  }
  return result;
}

export class ObstacleField {
  readonly #cells = new Map<string, Obstacle[]>();
  #reach = 0;

  constructor(obstacles: readonly Obstacle[] = []) {
    for (const o of obstacles) {
      this.#reach = Math.max(this.#reach, o.radius);
      const key = `${Math.floor(o.x / CELL_M)}:${Math.floor(o.z / CELL_M)}`;
      const cell = this.#cells.get(key);
      if (cell) cell.push(o); else this.#cells.set(key, [o]);
    }
  }

  get size(): number {
    let n = 0; for (const cell of this.#cells.values()) n += cell.length; return n;
  }

  /**
   * Where a body of `bodyRadius` at (x, z), walking along `heading`, is drawn so it stands
   * clear of every obstacle. It steps sideways, not straight out from the centre: a smooth
   * swerve that starts two clearances before the obstacle and rejoins the route two after,
   * so a walk that meets a trunk head-on bends round it instead of jumping to its far side.
   * The swerve is never sideways faster than 0.8x the walk, and always clears the edge.
   */
  deflect(x: number, z: number, bodyRadius: number, heading = 0): { x: number; z: number } {
    if (this.#cells.size === 0) return { x, z };
    const fx = Math.sin(heading), fz = Math.cos(heading); // Forward; (fz, -fx) is to the right.
    const reach = 2 * (this.#reach + bodyRadius);
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (let cx = Math.floor((x - reach) / CELL_M); cx <= Math.floor((x + reach) / CELL_M); cx++) {
        for (let cz = Math.floor((z - reach) / CELL_M); cz <= Math.floor((z + reach) / CELL_M); cz++) {
          for (const o of this.#cells.get(`${cx}:${cz}`) ?? []) {
            const clear = o.radius + bodyRadius, dx = x - o.x, dz = z - o.z;
            const along = dx * fx + dz * fz, side = dx * fz - dz * fx;
            const u = along / (2 * clear);
            if (Math.abs(u) >= 1) continue;
            // (1 - u^2)^2 bump: equals the edge at the centre line and stays outside the
            // circle everywhere else (it exceeds sqrt(clear^2 - along^2) for every along).
            const need = clear * (1 - u * u) ** 2;
            if (Math.abs(side) >= need) continue;
            // Dead ahead always passes on the right, rounding noise included, so it never flickers.
            const shift = (side < -1e-3 ? -need : need) - side;
            x += fz * shift; z -= fx * shift; moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return { x, z };
  }
}

/** An animal drawn near the camera, as a circle on the ground. */
export interface Body {
  id: string; x: number; z: number; radius: number; heading: number;
  /** The other animal of a recorded encounter: they are meant to meet, so they may touch. */
  partnerId?: string;
  /** A hunter (pools.ts HUNTERS): other animals keep HUNTER_BERTH_M from it unless they are its quarry. */
  hunter?: boolean;
}

/**
 * How far an animal is drawn from a hunter that is not hunting it, metres. The simulation places
 * animals by patch and water point, so a resting leopard and grazing duikers could be drawn side by
 * side; prey keep about a flight-initiation distance from a predator they have seen (duiker 15 m).
 */
export const HUNTER_BERTH_M = 8;

const pairAngle = (a: string, b: string): number => {
  let h = 2166136261;
  for (const c of a < b ? a + '|' + b : b + '|' + a) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h / 0xffffffff * Math.PI * 2;
};

/**
 * Draws nearby animals apart where their bodies would overlap each other or a person, then
 * round trunks and boulders. Each animal's route is recorded on its own, so two chital can be
 * given the same spot, or a boar the spot where a villager stands; only where they are drawn
 * changes, by as little as keeps them apart. A small body gives way more than a large one,
 * people are never moved, and a recorded predator and its prey may still meet.
 */
export function separateBodies(bodies: readonly Body[], people: readonly Obstacle[] = [],
  field: ObstacleField | null = null): Map<string, { x: number; z: number }> {
  const at = bodies.map((b) => ({ ...b }));
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < at.length; i++) {
      const a = at[i]!;
      for (let j = i + 1; j < at.length; j++) {
        const b = at[j]!;
        if (a.partnerId === b.id || b.partnerId === a.id) continue;
        // A hunter and an animal it is not hunting keep a berth, the other giving most of the way.
        const wary = !!a.hunter !== !!b.hunter;
        const clear = wary ? Math.max(a.radius + b.radius, HUNTER_BERTH_M) : a.radius + b.radius, dx = b.x - a.x, dz = b.z - a.z;
        if (Math.abs(dx) >= clear || Math.abs(dz) >= clear) continue;
        const d = Math.hypot(dx, dz);
        if (d >= clear) continue;
        const angle = pairAngle(a.id, b.id);
        const ux = d > 1e-6 ? dx / d : Math.sin(angle), uz = d > 1e-6 ? dz / d : Math.cos(angle);
        // Each gives way in proportion to the other's size: a hare steps aside for an elephant.
        const wa = a.radius ** 2, wb = b.radius ** 2, overlap = clear - d;
        const shareA = wary ? (a.hunter ? 0.3 : 0.7) : wb / (wa + wb);
        const moveA = overlap * shareA, moveB = overlap * (1 - shareA);
        a.x -= ux * moveA; a.z -= uz * moveA; b.x += ux * moveB; b.z += uz * moveB;
      }
      for (const p of people) {
        const clear = a.radius + p.radius, dx = a.x - p.x, dz = a.z - p.z, d = Math.hypot(dx, dz);
        if (d >= clear) continue;
        const angle = pairAngle(a.id, 'person');
        const ux = d > 1e-6 ? dx / d : Math.sin(angle), uz = d > 1e-6 ? dz / d : Math.cos(angle);
        a.x = p.x + ux * clear; a.z = p.z + uz * clear;
      }
    }
  }
  const result = new Map<string, { x: number; z: number }>();
  for (const a of at) result.set(a.id, field ? field.deflect(a.x, a.z, a.radius * 0.7, a.heading) : { x: a.x, z: a.z });
  return result;
}
