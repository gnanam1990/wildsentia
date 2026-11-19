/**
 * The worst cases of an agent's route-finding (packages/server/src/live/route.ts) on the Congo grid
 * (audit 17 November, "route-finding cost"): routes corner to corner, and routes to a goal no land
 * path reaches, which make A* visit every patch it can reach before it gives up.
 *
 *   npx tsx tools/ops/routeCost.ts [seed]
 */
import { CONGO_GRID, landWalkable, patchCentre, type Patch } from '@vana/shared';
import { buildGrid } from '@vana/sim';
import { landRoute } from '../../packages/server/src/live/route.js';

const seed = Number(process.argv[2] ?? 7);
const grid = CONGO_GRID, patches: Patch[] = buildGrid(seed, 'congo_v1', grid);
const land = patches.filter((p) => landWalkable(p));
console.log(`congo_v1 seed ${seed}: ${patches.length} patches, ${land.length} walkable`);

// Land patches cut off from the largest walkable area: a route there is the slowest refusal.
const component = new Int32Array(patches.length).fill(-1);
const sizes: number[] = [];
for (const p of land) {
  if (component[p.id] !== -1) continue;
  const c = sizes.length; let n = 0; const stack = [p.id]; component[p.id] = c;
  while (stack.length) {
    const id = stack.pop()!; n++;
    const x = id % grid.cols, y = Math.floor(id / grid.cols);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= grid.cols || ny >= grid.rows) continue;
      const nid = ny * grid.cols + nx;
      if (component[nid] !== -1 || !landWalkable(patches[nid])) continue;
      if (dx && dy && (!landWalkable(patches[y * grid.cols + nx]) || !landWalkable(patches[ny * grid.cols + x]))) continue;
      component[nid] = c; stack.push(nid);
    }
  }
  sizes.push(n);
}
const main = sizes.indexOf(Math.max(...sizes));
console.log(`walkable areas: ${sizes.length}, the largest ${sizes[main]} patches`);

const time = (from: Patch, to: Patch, cost = (h: string) => (h === 'swamp_forest' || h === 'flooded_forest' ? 3 : 1)) => {
  const a = patchCentre(grid, from.id), b = patchCentre(grid, to.id);
  const t0 = performance.now(); const route = landRoute(grid, patches, a, b, cost); return { ms: performance.now() - t0, found: !!route };
};
const inMain = land.filter((p) => component[p.id] === main);
const corner = (fx: number, fy: number) => inMain.reduce((best, p) => (Math.hypot(p.x - fx, p.y - fy) < Math.hypot(best.x - fx, best.y - fy) ? p : best));
const nw = corner(0, 0), se = corner(grid.cols, grid.rows), ne = corner(grid.cols, 0), sw = corner(0, grid.rows);
const cut = land.filter((p) => component[p.id] !== main);
const cases: Array<[string, Patch, Patch]> = [['NW to SE', nw, se], ['NE to SW', ne, sw]];
for (const target of cut.slice(0, 3)) cases.push([`NW to a cut-off patch ${target.id}`, nw, target]);
const results: number[] = [];
for (const [name, a, b] of cases) {
  time(a, b); // warm up
  const runs = Array.from({ length: 5 }, () => time(a, b));
  const ms = runs.map((r) => r.ms).sort((x, y) => x - y);
  results.push(ms[ms.length - 1]!);
  console.log(`${name.padEnd(32)} found ${runs[0]!.found}  median ${ms[2]!.toFixed(1)} ms  worst ${ms[4]!.toFixed(1)} ms`);
}
console.log(`worst of all: ${Math.max(...results).toFixed(1)} ms`);
