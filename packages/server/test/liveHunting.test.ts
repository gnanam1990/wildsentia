import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { landWalkable, patchCentre, EVEN_NEED } from '@vana/shared';
import { createWorld, type World } from '@vana/sim';
import { DEATH_COOLDOWN_MS, LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { ISLAND_GRID } from '@vana/shared';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

/** A tiger, chital and boar on open land, placed where the test says. */
function setup(random: () => number) {
  const world: World = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1',
    initialAgents: { tiger: 2, chital: 12, boar: 6 }, minPopulation: {} });
  // A land patch whose neighbours are land too, so nothing is blocked by the coast.
  const open = world.patches.find((p) => landWalkable(p) && p.neighbours.every((n) => landWalkable(world.patches[n])))!;
  const centre = patchCentre(ISLAND_GRID, open.id);
  let now = 5_000_000;
  const live = new LiveLayer(worldPort(() => world, () => 'w'), null, () => now, random);
  const put = (id: string, dx: number) => {
    const a = world.animal(id)!;
    a.patchId = open.id; a.position = { x: centre.x + dx, z: centre.z, heading: 0 };
  };
  const run = (seconds: number) => { for (let i = 0; i < seconds * 10; i++) { now += 100; live.tick(0.1); } };
  const adult = (species: string) => world.agents.find((a) => a.alive && a.speciesId === species && a.lifeStage === 'adult'
    && a.dependentOn === null && !world.agents.some((c) => c.alive && c.dependentOn === a.id))!;
  return { world, live, put, run, adult, advance: (ms: number) => { now += ms; } };
}

describe('live hunting', () => {
  it('lets an agent tiger run down a chital, kill it, and feed on the carcass', () => {
    const { world, live, put, run, adult } = setup(() => 0); // Every catch kills.
    const tiger = adult('tiger'), chital = adult('chital');
    put(tiger.id, 0); put(chital.id, 45);
    expect(live.possess('ag_t', 'Stripe', { animalId: tiger.id }).ok).toBe(true);
    expect(live.hunt('ag_t', chital.id)).toBeNull();
    run(3);
    expect(live.wild.has(chital.id)).toBe(false); // Stalking: unseen so far.
    expect(live.avatars.get('ag_t')!.gait).toBe('walk');
    run(20);
    expect(live.wild.get(chital.id)?.mode ?? 'caught').not.toBe('idle'); // It bolted once the tiger charged.
    run(40);
    expect(world.animal(chital.id)!.alive).toBe(false);
    expect(live.notices('ag_t').at(-1)!.text).toContain('You caught the chital');
    const hunt = world.log.all().find((e) => e.type === 'hunt' && e.actors[1] === chital.id)!;
    expect(hunt).toMatchObject({ outcome: 'success', conditions: { source: 'live', predatorSteered: 1 } });
    const hunger = (world.animal(tiger.id)!.drives.hunger = 0.8);
    expect(live.act('ag_t', 'feed')).toBeNull();
    run(31);
    expect(world.animal(tiger.id)!.drives.hunger).toBeLessThan(hunger);
  });

  it('refuses what is not the species’ prey, out of sight, or not a hunter at all', () => {
    const { live, put, adult } = setup(() => 0);
    const tiger = adult('tiger'), chital = adult('chital'), boar = adult('boar');
    put(tiger.id, 0); put(chital.id, 900); put(boar.id, 5);
    live.possess('ag_t', 'Stripe', { animalId: tiger.id });
    expect(live.hunt('ag_t', chital.id)).toBe('out_of_sight');
    live.possess('ag_c', 'Doe', { animalId: adult('chital').id });
    expect(live.hunt('ag_c', boar.id)).toBe('not_a_hunter');
    expect(live.act('ag_c', 'feed')).toBe('does_not_eat_meat');
  });

  it('lets the prey break free when the odds go its way', () => {
    const { world, live, put, run, adult } = setup(() => 0.99); // Every catch fails.
    const tiger = adult('tiger'), chital = adult('chital');
    put(tiger.id, 0); put(chital.id, 6);
    live.possess('ag_t', 'Stripe', { animalId: tiger.id });
    live.hunt('ag_t', chital.id);
    run(8);
    expect(world.animal(chital.id)!.alive).toBe(true);
    expect(live.notices('ag_t').some((n) => n.text.includes('broke free'))).toBe(true);
    expect(world.log.all().some((e) => e.type === 'hunt' && e.outcome === 'failure' && e.actors[1] === chital.id)).toBe(true);
  });

  it('sends a hungry wild tiger after an agent’s chital, and a death costs two minutes', () => {
    const { world, live, put, run, adult } = setup(() => 0);
    const tiger = adult('tiger'), chital = adult('chital');
    world.animal(tiger.id)!.drives.hunger = 0.8;
    put(tiger.id, 0); put(chital.id, 60);
    live.possess('ag_c', 'Doe', { animalId: chital.id });
    run(1.5);
    expect(live.wild.get(tiger.id)).toMatchObject({ mode: 'chase', otherId: chital.id, committed: false }); // Stalking.
    run(60);
    expect(live.notices('ag_c').some((n) => n.text.includes('charging at you'))).toBe(true);
    expect(world.animal(chital.id)!.alive).toBe(false);
    expect(live.avatars.has('ag_c')).toBe(false);
    expect(live.notices('ag_c').at(-1)!.text).toContain('caught by a tiger');
    expect(live.possess('ag_c', 'Doe', { speciesId: 'boar' })).toEqual({ ok: false, reason: 'cooldown' });
  });

  it('a wild hunter gives up when its breath runs out, and a sated one never starts', () => {
    const { world, live, put, run, adult, advance } = setup(() => 0);
    const tiger = adult('tiger'), chital = adult('chital');
    world.animal(tiger.id)!.drives.hunger = 0.1;
    put(tiger.id, 0); put(chital.id, 60);
    live.possess('ag_c', 'Doe', { animalId: chital.id });
    run(2);
    expect(live.wild.has(tiger.id)).toBe(false); // Not hungry: it lets the chital be.
    world.animal(tiger.id)!.drives.hunger = 0.8;
    run(1.2);
    const runner = live.wild.get(tiger.id)!;
    runner.committed = true; runner.stamina = 0; // Charged, and spent.
    run(0.2);
    expect(runner.mode).toBe('idle');
    expect(live.notices('ag_c').at(-1)!.text).toContain('gave up');
    void advance;
  });

  it('an agent’s hunter that is out of breath trots on, and sprints again only once it has recovered', () => {
    const { world, live, put, run, adult } = setup(() => 0);
    const tiger = adult('tiger'), chital = adult('chital');
    for (const t of world.agents) if (t.speciesId === 'tiger') t.drives.hunger = 0; // No wild tiger joins in.
    Object.assign(tiger.drives, { hunger: EVEN_NEED, thirst: EVEN_NEED, fatigue: EVEN_NEED }); // Even fitness: the species' own trot.
    put(tiger.id, 0); put(chital.id, 24); // Inside the tiger's commit distance: it charges.
    live.possess('ag_t', 'Stripe', { animalId: tiger.id });
    live.possess('ag_c', 'Doe', { animalId: chital.id }); // Steered, standing still: no wild bolt.
    const hunter = live.avatars.get('ag_t')!;
    expect(live.hunt('ag_t', chital.id)).toBeNull();
    hunter.stamina = 0; // Spent.
    const trot = world.species.get('tiger')!.locomotion.trotMs;
    for (let i = 0; i < 30; i++) {
      const before = { x: hunter.x, z: hunter.z };
      run(0.1);
      expect(hunter.gait).toBe('trot');
      expect(Math.hypot(hunter.x - before.x, hunter.z - before.z)).toBeLessThanOrEqual(trot * 0.1 + 1e-6);
    }
    expect(hunter.hunt?.targetId).toBe(chital.id); // Still after it, only slower.
    hunter.stamina = 0.5; // Rested enough to charge again.
    run(0.1);
    expect(hunter.gait).toBe('run');
  });

  it('a fleeing wild animal that is out of breath trots, not sprints', () => {
    const { world, live, put, run, adult } = setup(() => 0);
    const tiger = adult('tiger'), chital = adult('chital');
    for (const t of world.agents) if (t.speciesId === 'tiger') t.drives.hunger = 0;
    Object.assign(chital.drives, { hunger: EVEN_NEED, thirst: EVEN_NEED, fatigue: EVEN_NEED }); // Even fitness: the species' own trot.
    put(tiger.id, 0); put(chital.id, 30);
    live.possess('ag_t', 'Stripe', { animalId: tiger.id });
    const at = world.animal(chital.id)!.position!;
    live.wild.set(chital.id, { animalId: chital.id, speciesId: 'chital', x: at.x, z: at.z, heading: 0,
      mode: 'flee', otherId: tiger.id, stamina: 0, stunnedUntil: 0 });
    const runner = live.wild.get(chital.id)!;
    const trot = world.species.get('chital')!.locomotion.trotMs;
    for (let i = 0; i < 20; i++) {
      const before = { x: runner.x, z: runner.z };
      run(0.1);
      expect(runner.mode).toBe('flee');
      expect(Math.hypot(runner.x - before.x, runner.z - before.z)).toBeLessThanOrEqual(trot * 0.1 + 1e-6);
    }
  });
});
