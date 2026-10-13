import { describe, expect, it } from 'vitest';
import { createRng, patchCentre, type Agent } from '@vana/shared';
import { choosePrey, resolveHunt } from '../src/agents/predation.js';
import { createWorld } from '../src/world.js';
import { makeAgent, SPECIES_DIR, speciesOf } from './helpers.js';
import { ISLAND_GRID } from '@vana/shared';

const dhole = speciesOf('dhole');
const MORNING = 7;

/** One pack of four adults standing together beside chital, every adult hungry enough to hunt. */
function packWorld(seed: number) {
  const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: { dhole: 4, chital: 12 }, minPopulation: {} });
  world.step(MORNING); // sim_0.37.0: dholes hunt by day; start at 07:00
  const centre = patchCentre(ISLAND_GRID, 210);
  world.agents.forEach((a, i) => {
    a.patchId = 210;
    a.position = { x: centre.x + (a.speciesId === 'dhole' ? -60 + i * 8 : 20 + i * 3), z: centre.z, heading: 0 };
    a.drives = { hunger: a.speciesId === 'dhole' ? 0.6 : 0.2, thirst: 0.1, fatigue: 0, fear: 0 };
    delete a.gutKg;
  });
  world.__reindexForTest();
  return world;
}

describe('dholes hunt as a pack (sim_0.36.0)', () => {
  it('relays the chase: one of n hunters pulls the prey down with chance 1 - (1 - p)^n', () => {
    const input = { baseSuccess: 0.34, stalkConcealment: 0.35, canopyCover: 0.5, predatorStamina: 1,
      predatorCondition: 1, preyEvasiveness: 0.7, preyCondition: 1, preyAlert: false, herdSize: 6,
      distanceAtCommitM: 60, commitDistanceM: 90 };
    const rate = (hunters: number) => {
      const rng = createRng(11, `pack-${hunters}`);
      let kills = 0;
      for (let i = 0; i < 20_000; i++) if (resolveHunt({ ...input, hunters }, rng).killed) kills++;
      return kills / 20_000;
    };
    const one = rate(1), four = rate(4);
    expect(four).toBeGreaterThan(one * 2);
    // Detection still stops a share of hunts before the commit, whatever the pack size.
    expect(four).toBeLessThan(0.75);
  });

  it('chooses sambar over hare-sized meals and passes over pigs as the field records', () => {
    const at = (speciesId: string, n: number) => Array.from({ length: n }, (_, i) =>
      ({ agent: makeAgent(speciesId, { id: `${speciesId}${i}` }), patchId: 0, herdSize: n }));
    const counts: Record<string, number> = {};
    const rng = createRng(3, 'prey-choice');
    const candidates = [...at('sambar', 3), ...at('boar', 3), ...at('chital', 3)];
    for (let i = 0; i < 9000; i++) {
      const pick = choosePrey(candidates, rng, dhole.hunting!.preyPreference);
      counts[pick.agent.speciesId] = (counts[pick.agent.speciesId] ?? 0) + 1;
    }
    expect(counts.sambar! / counts.chital!).toBeCloseTo(2.1, 0);
    expect(counts.boar! / counts.chital!).toBeCloseTo(0.54, 0);
    // A predator without a configured preference keeps the plain type III choice.
    expect(choosePrey(at('boar', 1), rng).agent.speciesId).toBe('boar');
  });

  it('a packmate that already ranged this hour does not join a later hunt and move again', () => {
    // Joining was open to a packmate that had already decided to wander this hour, so it walked
    // its hour away and then ran to the kill in the same hour: two journeys in one decision.
    let joined = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const world = packWorld(seed), start = world.now();
      // The first dhole decides first: sated, it ranges; the others are hungry and hunt.
      world.agents.find(a => a.speciesId === 'dhole')!.drives.hunger = 0.05;
      world.step(1);
      const events = world.log.all().filter(e => e.worldTime >= start);
      for (const hunt of events.filter(e => e.type === 'hunt' && typeof e.conditions.packmateIds === 'string')) {
        for (const mate of String(hunt.conditions.packmateIds).split(',')) {
          joined++;
          const journeys = events.filter(e => e.movement?.actorId === mate && e.goal !== 'hunt');
          expect(journeys.filter(e => e.goal === 'wander'), `seed ${seed} ${mate}`).toEqual([]);
        }
      }
    }
    expect(joined).toBeGreaterThan(5);
  });

  it('lets a hungry packmate initiate before a sated member spends the shared hour wandering', () => {
    let joint = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const world = packWorld(seed), start = world.now();
      const first = world.agents.find(a => a.speciesId === 'dhole')!;
      first.drives.hunger = 0.05;
      world.step(1);
      const events = world.log.all().filter(e => e.worldTime >= start);
      const hunt = events.find(e => e.type === 'hunt' && e.conditions.predatorSpecies === 'dhole');
      if (!hunt || !String(hunt.conditions.packmateIds).split(',').includes(first.id)) continue;
      joint++;
      expect(hunt.actors[0]).not.toBe(first.id);
      expect(events.filter(e => e.movement?.actorId === first.id && e.goal === 'wander')).toEqual([]);
      for (const move of events.filter(e => e.movement?.actorId === first.id)) {
        expect(move.movement!.startWorldTime).toBeGreaterThanOrEqual(start);
        expect(move.movement!.startWorldTime + (move.movement!.samples.at(-1)?.seconds ?? 0)).toBeLessThanOrEqual(start + 3600);
      }
    }
    expect(joint).toBeGreaterThan(15);
  });

  it('packmates close by join the commit, spend their hour on it and feed together at the kill', () => {
    let seen = false;
    for (let seed = 1; seed <= 40 && !seen; seed++) {
      const world = packWorld(seed);
      const before = new Map(world.agents.map(a => [a.id, a.drives.hunger]));
      world.step(1);
      const hunts = world.log.all().filter(e => e.type === 'hunt' && e.conditions.predatorSpecies === 'dhole');
      // Joiners do not start hunts of their own: one pack hunt, not four solo ones.
      const pack = hunts.find(e => Number(e.conditions.packHunters ?? 1) >= 2);
      if (!pack) continue;
      expect(hunts.filter(e => !String(pack.conditions.packmateIds).split(',').includes(e.actors[0]!)).length).toBe(hunts.length);
      if (pack.outcome !== 'success') continue;
      seen = true;
      const party = [pack.actors[0]!, ...String(pack.conditions.packmateIds).split(',')];
      expect(party.length).toBe(Number(pack.conditions.packHunters));
      const carcass = world.carcasses.find(c => c.originId === pack.actors[1])!;
      const eaters = new Set(carcass.consumers.map(c => c.agentId));
      for (const id of party) {
        const mate = world.agents.find(a => a.id === id) as Agent;
        expect(eaters.has(id)).toBe(true);
        expect(mate.drives.hunger).toBeLessThan(before.get(id)!);
      }
      // Every kilogram eaten came off the one carcass.
      const eaten = carcass.consumers.reduce((kg, c) => kg + c.kg, 0);
      expect(carcass.originalMassKg - eaten).toBeGreaterThan(0);
    }
    expect(seen).toBe(true);
  });

  it('a pack hunting together goes for prey of 30-235 kg; a dhole with no packmate still takes a hare', () => {
    const preyOf = (packmates: boolean) => {
      const picks: string[] = [];
      for (let seed = 1; seed <= 30; seed++) {
        const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: { dhole: 2, hare: 6, chital: 1 }, minPopulation: {} });
        world.step(MORNING); // sim_0.37.0: dholes hunt by day; start at 07:00
        const centre = patchCentre(ISLAND_GRID, 210);
        const [lead, mate] = world.agents.filter(a => a.speciesId === 'dhole') as [Agent, Agent];
        world.agents.forEach((a, i) => { a.patchId = 210; a.position = { x: centre.x + 30 + i * 4, z: centre.z, heading: 0 };
          a.drives = { hunger: 0.2, thirst: 0.1, fatigue: 0, fear: 0 }; });
        lead.position = { x: centre.x - 40, z: centre.z, heading: 0 };
        lead.drives.hunger = 0.7; delete lead.gutKg;
        mate.position = packmates ? { x: centre.x - 45, z: centre.z, heading: 0 } : { ...patchCentre(ISLAND_GRID, 250), heading: 0 };
        if (!packmates) { mate.patchId = 250; mate.alive = false; }
        world.__reindexForTest();
        world.step(1);
        const hunt = world.log.all().find(e => e.type === 'hunt' && e.actors[0] === lead.id);
        if (hunt) picks.push(String(hunt.conditions.preySpecies));
      }
      return picks;
    };
    const together = preyOf(true), alone = preyOf(false);
    expect(together.length).toBeGreaterThan(0);
    expect(together.every(p => p === 'chital')).toBe(true);
    expect(alone.filter(p => p === 'hare').length).toBeGreaterThan(alone.length / 2);
  });

  it('a dhole whose packmates are out of reach goes to them before hunting (sim_0.37.0)', () => {
    let moved = 0, solo = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: { dhole: 2, hare: 6 }, minPopulation: {} });
      world.step(MORNING); // sim_0.37.0: dholes hunt by day; start at 07:00
      const centre = patchCentre(ISLAND_GRID, 210);
      const [lead, mate] = world.agents.filter(a => a.speciesId === 'dhole') as [Agent, Agent];
      world.agents.forEach((a, i) => { a.patchId = 210; a.position = { x: centre.x + 30 + i * 4, z: centre.z, heading: 0 };
        a.drives = { hunger: 0.2, thirst: 0.1, fatigue: 0, fear: 0 }; });
      lead.position = { x: centre.x - 40, z: centre.z, heading: 0 };
      lead.drives.hunger = 0.7; delete lead.gutKg;
      mate.patchId = 250; mate.position = { ...patchCentre(ISLAND_GRID, 250), heading: 0 };
      world.__reindexForTest();
      world.step(1);
      if (world.log.all().some(e => e.type === 'hunt' && e.actors[0] === lead.id)) solo++;
      if (world.log.all().some(e => e.type === 'moved' && e.actors[0] === lead.id && e.goal === 'hunt')) moved++;
    }
    expect(solo).toBe(0);
    expect(moved).toBeGreaterThan(10);
  });

  it('does not rendezvous with a carrier that cannot join this hour instead of hunting locally', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: { dhole: 2, hare: 6 }, minPopulation: {} });
      world.step(MORNING);
      const centre = patchCentre(ISLAND_GRID, 210);
      const [lead, carrier] = world.agents.filter(a => a.speciesId === 'dhole') as [Agent, Agent];
      world.carcasses.length = 0;
      world.agents.forEach((a, i) => {
        a.patchId = 210; a.position = { x: centre.x + 30 + i * 4, z: centre.z, heading: 0 };
        a.drives = { hunger: 0.2, thirst: 0.1, fatigue: 0, fear: 0 };
        delete a.gutKg; delete a.failedHunts;
      });
      lead.position = { x: centre.x - 40, z: centre.z, heading: 0 }; lead.drives.hunger = 0.7;
      carrier.patchId = 250; carrier.position = { ...patchCentre(ISLAND_GRID, 250), heading: 0 };
      carrier.packFood = { kg: 1, moistureLPerKg: 0.65, sourceCarcassId: 'reserved', sourceActorId: 'prey',
        sourceEventId: 'reserved-event', collectedAt: world.now(), expiresAt: world.now() + 6 * 3600,
        recipientId: 'recipient', packId: carrier.groupId! };
      world.__reindexForTest();
      const start = world.now(); world.step(1);
      const hunts = world.log.all().filter(e => e.worldTime >= start && e.type === 'hunt' && e.actors[0] === lead.id);
      expect(hunts, `seed ${seed}`).toHaveLength(1);
      expect(hunts[0]!.conditions.preySpecies).toBe('hare');
    }
  });

  it('the mother of pups too young to follow stays at the den instead of joining', () => {
    const world = packWorld(5);
    const dholes = world.agents.filter(a => a.speciesId === 'dhole');
    const mother = dholes[3]!, pup = dholes[0]!;
    Object.assign(pup, makeAgent('dhole', { id: pup.id, ageDays: 20, lifeStage: 'newborn', dependentOn: mother.id,
      motherId: mother.id, massKg: 17 * 0.12, patchId: 210, groupId: mother.groupId, position: { ...mother.position! } }));
    mother.sex = 'female'; mother.offspringIds = [pup.id];
    world.__reindexForTest();
    let packHunts = 0;
    for (let h = 0; h < 12; h++) {
      for (const a of dholes) if (a !== pup) { a.drives.hunger = Math.max(a.drives.hunger, 0.6); delete a.gutKg; }
      world.step(1);
    }
    for (const hunt of world.log.all().filter(e => e.type === 'hunt' && e.conditions.packmateIds !== undefined)) {
      packHunts++;
      expect([hunt.actors[0], ...String(hunt.conditions.packmateIds).split(',')]).not.toContain(mother.id);
    }
    expect(packHunts).toBeGreaterThan(0);
  });
});