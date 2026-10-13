import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { landWalkable, patchAtPosition, patchCentre, treeAnchorForPatch } from '@vana/shared';
import { createWorld, type World } from '@vana/sim';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { clearOverLand, landRoute } from '../src/live/route.js';
import { ISLAND_GRID } from '@vana/shared';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

function setup(initialAgents: Record<string, number>, random: () => number = () => 0) {
  const world: World = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1', initialAgents, minPopulation: {} });
  let now = 5_000_000;
  const live = new LiveLayer(worldPort(() => world, () => 'w'), null, () => now, random);
  const open = world.patches.find((p) => landWalkable(p) && p.neighbours.every((n) => landWalkable(world.patches[n])))!;
  const centre = patchCentre(ISLAND_GRID, open.id);
  const put = (id: string, dx: number, dz = 0, patch = open.id, from = centre) => {
    const a = world.animal(id)!; a.patchId = patch; a.position = { x: from.x + dx, z: from.z + dz, heading: 0 };
  };
  const run = (seconds: number) => { for (let i = 0; i < seconds * 10; i++) { now += 100; live.tick(0.1); } };
  const adults = (species: string) => world.agents.filter((a) => a.alive && a.speciesId === species && a.lifeStage === 'adult'
    && a.dependentOn === null && !world.agents.some((c) => c.alive && c.dependentOn === a.id));
  return { world, live, put, run, adults, centre, open };
}

describe('species abilities and fair turns', () => {
  it('puts an agent in line for a tiger, and hands it the next one that comes free', () => {
    const { live } = setup({ tiger: 2, chital: 6 });
    expect(live.possess('ag_a', 'Amba', { speciesId: 'tiger' }).ok).toBe(true); // One of two; the other stays wild.
    expect(live.possess('ag_b', 'Bagh', { speciesId: 'tiger' })).toEqual({ ok: false, reason: 'queued:1' });
    expect(live.possess('ag_c', 'Chita', { speciesId: 'tiger' })).toEqual({ ok: false, reason: 'queued:2' });
    live.release('ag_a');
    expect(live.avatars.get('ag_b')?.speciesId).toBe('tiger');
    expect(live.notices('ag_b').some((n) => n.text.startsWith('Your turn'))).toBe(true);
    expect(live.avatars.has('ag_c')).toBe(false);
  });

  it('lets a langur climb its patch tree, where no ground hunter can follow', () => {
    const { world, live, put, run, adults } = setup({ langur: 10, tiger: 2 });
    const treePatch = world.patches.find((p) => landWalkable(p) && treeAnchorForPatch(ISLAND_GRID, p))!;
    const tree = treeAnchorForPatch(ISLAND_GRID, treePatch)!;
    const langur = adults('langur')[0]!, tiger = adults('tiger')[0]!;
    put(langur.id, 2, 0, treePatch.id, tree); put(tiger.id, 20, 0, treePatch.id, tree);
    world.animal(tiger.id)!.drives.hunger = 0.9;
    live.possess('ag_l', 'Hanu', { animalId: langur.id });
    run(1.2);
    expect(live.wild.get(tiger.id)?.mode).toBe('chase');
    expect(live.climb('ag_l')).toBeNull();
    run(0.3);
    expect(live.wild.get(tiger.id)?.mode).toBe('idle');
    expect(live.notices('ag_l').some((n) => n.text.includes('cannot follow you up the tree'))).toBe(true);
    expect(live.act('ag_l', 'graze')).toBe('come_down_first');
    expect(live.publicState().avatars[0]).toMatchObject({ altitude: 6 });
    run(3);
    expect(world.animal(langur.id)!.alive).toBe(true);
    live.possess('ag_x', 'X', { speciesId: 'chital' });
    expect(live.climb('ag_x')).toBe('not_possessing');
  });

  it('leaves no tree, chase or open behind when the next action starts', () => {
    const { world, put, adults } = setup({ leopard: 4, chital: 6 });
    const treePatch = world.patches.find((p) => landWalkable(p) && treeAnchorForPatch(ISLAND_GRID, p))!;
    const tree = treeAnchorForPatch(ISLAND_GRID, treePatch)!;
    const leopard = adults('leopard')[0]!, chital = adults('chital')[0]!;
    put(leopard.id, 1, 0, treePatch.id, tree); put(chital.id, 30, 0, treePatch.id, tree);
    const now = 9_000_000;
    const drop = { id: 'd1', amountMicro: '1000000', x: tree.x + 1, z: tree.z, hintX: tree.x, hintZ: tree.z, hintRadius: 50, expiresAt: now + 3_600_000, spottedBy: null };
    const withDrops = new LiveLayer(worldPort(() => world, () => 'w'), { active: () => [drop], spot: () => undefined,
      claim: async () => ({ ok: true as const, claimId: 'c' }) }, () => now, () => 0);
    expect(withDrops.possess('ag_p', 'Bagheera', { animalId: leopard.id }).ok).toBe(true);
    const a = withDrops.avatars.get('ag_p')!;
    // Opening a drop, then up the tree: the open does not carry on in the branches.
    expect(withDrops.openDrop('ag_p', 'd1')).toBeNull();
    expect(withDrops.climb('ag_p')).toBeNull();
    expect(a.opening).toBeNull();
    // From the tree straight into a hunt: it is on the ground again, reachable, and shown there.
    expect(withDrops.hunt('ag_p', chital.id)).toBeNull();
    expect(a.perched).toBe(false);
    expect(withDrops.publicState().avatars[0]).not.toHaveProperty('altitude');
    // Up again, then to the drop: it comes down to open it.
    expect(withDrops.climb('ag_p')).toBeNull();
    expect(withDrops.openDrop('ag_p', 'd1')).toBeNull();
    expect(a.perched).toBe(false);
    expect(a.hunt).toBeNull();
  });

  it('gives a dhole better odds with packmates closing on the same prey', () => {
    const odds = (pack: number) => {
      const { world, live, put, run, adults } = setup({ dhole: 6, chital: 10 }, () => 0.45);
      const [lead, ...others] = adults('dhole'), chital = adults('chital')[0]!;
      put(lead!.id, 0); put(chital.id, 1); // Within reach: the odds are rolled on the first step.
      live.possess('ag_d', 'Kodi', { animalId: lead!.id });
      live.tick(0.01); // Past the first tick's new-hour sweep of finished chases.
      for (const d of others.slice(0, pack)) {
        put(d.id, 1, 3);
        live.wild.set(d.id, { animalId: d.id, speciesId: 'dhole', x: world.animal(d.id)!.position!.x, z: world.animal(d.id)!.position!.z,
          heading: 0, mode: 'idle', otherId: null, stamina: 1, stunnedUntil: 0 });
      }
      live.hunt('ag_d', chital.id);
      run(0.5);
      return world.animal(chital.id)!.alive;
    };
    expect(odds(0)).toBe(true);  // Alone: 0.34 x 0.84 = 0.29, below the 0.45 roll.
    expect(odds(2)).toBe(false); // With two: x5/3 = 0.48, above it.
  });

  it('warns a herd when one of them is charged', () => {
    const { world, live, put, run, adults } = setup({ chital: 12, tiger: 2 });
    const [a, b] = adults('chital'), tiger = adults('tiger')[0]!;
    put(a!.id, 0); put(b!.id, 30); put(tiger.id, -20);
    world.animal(tiger.id)!.drives.hunger = 0.9;
    live.possess('ag_a', 'Mira', { animalId: a!.id });
    live.possess('ag_b', 'Tavi', { animalId: b!.id });
    run(6);
    expect(live.notices('ag_b').some((n) => n.text.startsWith('Alarm'))).toBe(true);
  });

  it('flies a vulture straight over water or sea, landing only on land', () => {
    const { world, live } = setup({ vulture: 6, chital: 4 });
    const land = world.patches.filter((p) => landWalkable(p));
    let pair: { from: { x: number; z: number }; to: { x: number; z: number } } | null = null;
    for (const p of land) { for (const q of land) {
      const from = patchCentre(ISLAND_GRID, p.id), to = patchCentre(ISLAND_GRID, q.id);
      if (p.id < q.id && !clearOverLand(ISLAND_GRID, world.patches, from, to) && landRoute(ISLAND_GRID, world.patches, from, to, () => 1)) { pair = { from, to }; break; }
    } if (pair) break; }
    expect(pair).not.toBeNull();
    const vulture = world.agents.find((x) => x.speciesId === 'vulture' && world.possessionBlock(x.id) === null)!;
    vulture.patchId = world.patches.find((p) => Math.abs(p.x * 300 - pair!.from.x) < 1 && Math.abs(p.y * 300 - pair!.from.z) < 1)!.id;
    vulture.position = { ...pair!.from, heading: 0 };
    live.possess('ag_v', 'Giddh', { animalId: vulture.id });
    expect(live.moveTo('ag_v', [pair!.to], 'walk')).toBeNull(); // Walking is fine to ask for...
    expect(live.moveTo('ag_v', [pair!.to], 'run')).toBeNull();  // ...but flying goes straight over.
    for (let i = 0; i < 6000 && live.avatars.get('ag_v')!.moving; i++) {
      live.tick(0.1);
      expect(landWalkable(world.patches[world.animal(vulture.id)!.patchId])).toBe(true); // The world only ever sees it over land.
    }
    const v = live.avatars.get('ag_v')!;
    expect(Math.hypot(v.x - pair!.to.x, v.z - pair!.to.z)).toBeLessThan(1);
    expect(live.notices('ag_v').some((n) => n.text.startsWith('Blocked'))).toBe(false);
    const sea = world.patches.find((p) => !landWalkable(p))!;
    expect(live.moveTo('ag_v', [patchCentre(ISLAND_GRID, sea.id)], 'run')).toBe('not_on_land'); // Cannot land on the sea.
  });

  it('lands a vulture that is told to stop over land, and refuses to set it down on water', () => {
    const { world, live } = setup({ vulture: 6, chital: 4 });
    const land = world.patches.filter((p) => landWalkable(p));
    let pair: { from: { x: number; z: number }; to: { x: number; z: number } } | null = null;
    for (const p of land) { for (const q of land) {
      const from = patchCentre(ISLAND_GRID, p.id), to = patchCentre(ISLAND_GRID, q.id);
      if (p.id < q.id && !clearOverLand(ISLAND_GRID, world.patches, from, to) && landRoute(ISLAND_GRID, world.patches, from, to, () => 1)) { pair = { from, to }; break; }
    } if (pair) break; }
    const vulture = world.agents.find((x) => x.speciesId === 'vulture' && world.possessionBlock(x.id) === null)!;
    vulture.patchId = patchAtPosition(ISLAND_GRID, { ...pair!.from, heading: 0 });
    vulture.position = { ...pair!.from, heading: 0 };
    live.possess('ag_v', 'Giddh', { animalId: vulture.id });
    const v = live.avatars.get('ag_v')!;
    const overLand = () => landWalkable(world.patches[patchAtPosition(ISLAND_GRID, { x: v.x, z: v.z, heading: 0 })]);
    expect(live.moveTo('ag_v', [pair!.to], 'run')).toBeNull();
    live.tick(0.1);
    expect(v.flying).toBe(true);
    // Stopped over land, it comes down where it is, not hanging in the air out of every hunter's reach.
    expect(live.stop('ag_v')).toBeNull();
    expect(v.flying).toBe(false);
    expect(world.animal(vulture.id)!.position).toMatchObject({ x: v.x, z: v.z });
    expect(live.publicState().avatars.find((a) => (a as { agentId: string }).agentId === 'ag_v')).not.toHaveProperty('altitude');
    // Over water it cannot land: it keeps flying, and says so.
    expect(live.moveTo('ag_v', [pair!.to], 'run')).toBeNull();
    for (let i = 0; i < 6000 && overLand() && v.moving; i++) live.tick(0.1);
    expect(overLand()).toBe(false);
    expect(live.stop('ag_v')).toBe('not_on_land');
    expect(live.act('ag_v', 'rest')).toBe('not_on_land');
    expect(v.flying).toBe(true);
    expect(v.moving).toBe(true);
  });
});
