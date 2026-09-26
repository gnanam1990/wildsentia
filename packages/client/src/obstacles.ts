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
