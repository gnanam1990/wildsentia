import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { landWalkable, patchCentre, treeAnchorForPatch } from '@vana/shared';
import { createWorld, type World } from '@vana/sim';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { clearOverLand, landRoute } from '../src/live/route.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

function setup(initialAgents: Record<string, number>, random: () => number = () => 0) {
  const world: World = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1', initialAgents, minPopulation: {} });
  let now = 5_000_000;
  const live = new LiveLayer(worldPort(() => world, () => 'w'), null, () => now, random);
  const open = world.patches.find((p) => landWalkable(p) && p.neighbours.every((n) => landWalkable(world.patches[n])))!;
  const centre = patchCentre(open.id);
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
    const treePatch = world.patches.find((p) => landWalkable(p) && treeAnchorForPatch(p))!;
    const tree = treeAnchorForPatch(treePatch)!;
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
      const from = patchCentre(p.id), to = patchCentre(q.id);
      if (p.id < q.id && !clearOverLand(world.patches, from, to) && landRoute(world.patches, from, to, () => 1)) { pair = { from, to }; break; }
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
    expect(live.moveTo('ag_v', [patchCentre(sea.id)], 'run')).toBe('not_on_land'); // Cannot land on the sea.
  });
});
