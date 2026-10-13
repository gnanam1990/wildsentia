import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { landWalkable, patchCentre } from '@vana/shared';
import { createWorld } from '@vana/sim';
import { clearOverLand, landRoute } from '../src/live/route.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { ISLAND_GRID } from '@vana/shared';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const world = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { sambar: 10 }, minPopulation: {} });
const land = world.patches.filter((p) => landWalkable(p));
const flat = () => 1;

/** Two land points whose straight line crosses water or sea, but which land connects. */
function detourPair() {
  for (const a of land) for (const b of land) {
    const from = patchCentre(ISLAND_GRID, a.id), to = patchCentre(ISLAND_GRID, b.id);
    if (a.id >= b.id || clearOverLand(ISLAND_GRID, world.patches, from, to)) continue;
    const route = landRoute(ISLAND_GRID, world.patches, from, to, flat);
    if (route && route.points.length > 1) return { from, to, route };
  }
  throw new Error('no detour on this island');
}

describe('land routes', () => {
  it('goes straight when the straight line stays on land', () => {
    const a = land[0]!, from = patchCentre(ISLAND_GRID, a.id), to = { x: from.x + 10, z: from.z + 5 };
    expect(landRoute(ISLAND_GRID, world.patches, from, to, flat)).toEqual({ points: [to], metres: Math.hypot(10, 5) });
  });

  it('goes round water and sea, every leg on land, ending where asked', () => {
    const { from, to, route } = detourPair();
    let prev = from;
    for (const p of route.points) { expect(clearOverLand(ISLAND_GRID, world.patches, prev, p)).toBe(true); prev = p; }
    expect(route.points.at(-1)).toEqual(to);
    expect(route.metres).toBeGreaterThan(Math.hypot(to.x - from.x, to.z - from.z));
  });

  it('has no route into the sea or from off the island', () => {
    const sea = world.patches.find((p) => !landWalkable(p))!;
    expect(landRoute(ISLAND_GRID, world.patches, patchCentre(ISLAND_GRID, land[0]!.id), patchCentre(ISLAND_GRID, sea.id), flat)).toBeNull();
    expect(landRoute(ISLAND_GRID, world.patches, { x: -9999, z: 0 }, patchCentre(ISLAND_GRID, land[0]!.id), flat)).toBeNull();
  });

  it('prefers open ground to a costlier habitat when both reach the goal', () => {
    const { from, to } = detourPair();
    const cheap = landRoute(ISLAND_GRID, world.patches, from, to, flat)!;
    const costly = landRoute(ISLAND_GRID, world.patches, from, to, (h) => (h === 'shola' ? 5 : 1))!;
    expect(costly.points.length).toBeGreaterThan(0);
    expect(cheap.metres).toBeLessThanOrEqual(costly.metres + 1e-6);
  });

  it('takes an agent round the obstacle without being blocked', () => {
    const { from, to } = detourPair();
    const w = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { sambar: 10 }, minPopulation: {} });
    const live = new LiveLayer(worldPort(() => w, () => 'w'));
    live.possess('ag_1', 'Sora', { speciesId: 'sambar' });
    const a = live.avatars.get('ag_1')!;
    w.placeControlled(a.animalId, { ...from, heading: 0 }); a.x = from.x; a.z = from.z;
    expect(live.goTo('ag_1', to, 'run')).toBeNull();
    for (let i = 0; i < 20_000 && a.moving; i++) { a.stamina = 1; live.tick(1); }
    expect(Math.hypot(a.x - to.x, a.z - to.z)).toBeLessThan(1);
    expect(live.notices('ag_1').some((n) => n.text.startsWith('Blocked'))).toBe(false);
  });
});
