import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { isCommunityState, spatialHash, type Agent } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { makeCarcass } from '../src/fields/decomposition.js';
import { stepCommunity, type CommunityWildlife } from '../src/community.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

function fixture(version: 5 | 6 = 6) {
  const world = createWorld({ seed: 1, speciesDir, terrainProfile: 'island_v1',
    communityProfile: 'household_v1', initialCommunityRulesVersion: version,
    initialAgents: { hare: 1 }, minPopulation: {} });
  const community = world.community!, person = community.people[0]!, prey = world.agents[0]!;
  for (const other of community.people.slice(1)) { other.alive = false; other.diedAt = 0; }
  person.needs = { hunger: .7, thirst: .1, fatigue: .1 };
  community.stores.waterL = 10; community.stores.timberKg = 5;
  prey.massKg = 3; prey.patchId = community.patchId;
  prey.position = { ...person.position, x: person.position.x + 6 };
  if (version === 6) {
    person.skills.hunting = 1;
    // Choose a persisted event sequence whose deterministic attempt roll succeeds.
    for (let sequence = world.log.exportSequence(); sequence < 1000; sequence++) {
      const id = `human_task_started_00000001${sequence.toString(16).padStart(16, '0')}`;
      if (spatialHash(`${id}:hunt`) / 0x1_0000_0000 < .7) {
        world.log.restoreSequence(sequence); break;
      }
    }
  }
  const wildlife: CommunityWildlife = {
    nearbyPrey: () => prey.alive ? prey : null,
    preyById: (id) => id === prey.id ? prey : null,
    kill: (animal: Agent, hunter, at) => {
      animal.alive = false;
      const carcass = makeCarcass('carc_test', animal.id, animal.speciesId, animal.patchId, at,
        'predation', 'authoritative', animal.massKg);
      carcass.position = { ...animal.position! };
      world.carcasses.push(carcass);
      expect(hunter.id).toBe(person.id);
      return carcass;
    },
  };
  const step = (seconds: number) => stepCommunity(community, world.patches, world.waterBudget,
    community.updatedAt, seconds, world.log, world.microEcology, wildlife);
  return { world, community, person, prey, wildlife, step };
}

describe('household v6 finite wildlife hunting', () => {
  it('runs through World ownership: local prey is observed, animal state/carcass change only on a recorded success', () => {
    const world = createWorld({ seed: 1, speciesDir, terrainProfile: 'island_v1',
      communityProfile: 'household_v1', initialCommunityRulesVersion: 6,
      initialAgents: { hare: 24 }, minPopulation: {} });
    const community = world.community!, home = community.building.position;
    for (const person of community.people) person.needs.hunger = .7;
    community.stores.waterL = 30;
    for (let i = 0; i < world.agents.length; i++) {
      const hare = world.agents[i]!;
      hare.patchId = community.patchId;
      hare.position = { x: home.x + 5 + (i % 4) * 2, z: home.z + 5 + Math.floor(i / 4) * 2, heading: 0 };
    }
    const baseline = world.totalNutrients();
    world.step(1);
    const attempts = world.log.all().filter(e => e.type === 'human_hunt');
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every(e => e.worldTime === 3600)).toBe(true);
    expect(attempts.some(e => e.outcome === 'success')).toBe(true);
    for (const e of attempts.filter(e => e.outcome === 'success')) {
      expect(world.carcasses.some(c => c.originId === e.conditions.preyId && c.id === e.conditions.carcassId)).toBe(true);
      expect(world.agents.find(a => a.id === e.conditions.preyId)?.alive).toBe(false);
    }
    expect(world.totalNutrients()).toBeCloseTo(baseline, 4);
    expect(isCommunityState(community)).toBe(true);
  });

  it('records contact and success, transfers only carcass tissue to raw inventory, and conserves nutrients through cooking', () => {
    const { world, community, person, prey, step } = fixture();
    const baseline = world.totalNutrients();
    step(1);
    expect(person.task).toMatchObject({ kind: 'hunt', targetAgentId: prey.id });
    expect(isCommunityState(community)).toBe(true);
    expect(prey.alive).toBe(true); expect(person.inventory.rawMeatKg).toBe(0);
    step(1300);
    const event = world.log.all().find(e => e.type === 'human_hunt')!;
    expect(event).toMatchObject({ outcome: 'success', conditions: { preyId: prey.id, carcassId: 'carc_test' } });
    expect(prey.alive).toBe(false); expect(world.carcasses).toHaveLength(1);
    expect((person.inventory.rawMeatKg ?? 0) + (community.stores.rawMeatKg ?? 0)).toBeGreaterThan(0);
    expect(world.carcasses[0]!.biomass.bone).toBeGreaterThan(0);
    expect(world.totalNutrients()).toBeCloseTo(baseline, 7);
    expect(isCommunityState(community)).toBe(true);
    for (let i = 0; i < 240 && !world.log.all().some(e => e.type === 'human_task_finished'
      && e.conditions.action === 'cook' && e.outcome === 'success'); i++) step(60);
    const delivered = world.log.all().find(e => e.type === 'human_task_finished'
      && e.conditions.action === 'deliver' && (e.effects.rawMeatKg ?? 0) > 0)!;
    const cooked = world.log.all().find(e => e.type === 'human_task_finished'
      && e.conditions.action === 'cook' && e.outcome === 'success')!;
    expect(delivered).toBeDefined(); expect(cooked).toBeDefined();
    expect(cooked.effects.rawMeatKg).toBeLessThan(0);
    expect(cooked.effects.foodKg).toBeGreaterThan(0);
    expect(world.totalNutrients()).toBeCloseTo(baseline, 7);
    expect(isCommunityState(community)).toBe(true);
  });

  it('fails closed when the observed prey leaves before contact, with no carcass or meat grant', () => {
    const { world, community, person, prey, step } = fixture();
    step(1);
    prey.position = { ...prey.position!, x: prey.position!.x + 40 };
    step(1300);
    expect(world.log.all().find(e => e.type === 'human_hunt')).toMatchObject({ outcome: 'failure',
      conditions: { reason: 'prey_gone_or_no_contact' } });
    expect(prey.alive).toBe(true); expect(person.inventory.rawMeatKg).toBe(0);
    expect(world.carcasses).toHaveLength(0); expect(isCommunityState(community)).toBe(true);
  });

  it('does not silently add hunting to saved v5 households', () => {
    const { community, person, step } = fixture(5);
    step(1);
    expect(community.version).toBe(5);
    expect(person.skills.hunting).toBeUndefined(); expect(person.inventory.rawMeatKg).toBeUndefined();
    expect(person.task?.kind).not.toBe('hunt'); expect(isCommunityState(community)).toBe(true);
  });

  it('restores an in-flight target and repeats the same attempt, and rejects malformed v6 state', () => {
    const options = { seed: 1, speciesDir, terrainProfile: 'island_v1' as const,
      communityProfile: 'household_v1' as const, initialCommunityRulesVersion: 6 as const,
      initialAgents: { hare: 1 }, minPopulation: {} };
    const world = createWorld(options), person = world.community!.people[0]!, prey = world.agents[0]!;
    person.needs.hunger = .7; world.community!.stores.waterL = 10;
    prey.patchId = world.community!.patchId;
    prey.position = { ...person.position, x: person.position.x + 6 };
    world.step(.01);
    const snapshot = takeSnapshot(world), restored = restoreSnapshot(structuredClone(snapshot), options);
    expect(isCommunityState(restored.community)).toBe(true);
    expect(restored.community!.version).toBe(6);
    world.log.take(); restored.log.take();
    for (let i = 0; i < 40; i++) { world.step(.01); restored.step(.01); }
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(world));
    expect(restored.log.all()).toEqual(world.log.all());
    const malformed = structuredClone(snapshot.community!);
    delete malformed.stores.rawMeatKg;
    expect(isCommunityState(malformed)).toBe(false);
    const task = snapshot.community!.people.find(p => p.task?.kind === 'hunt')?.task;
    expect(task).toBeDefined();
    const missingTarget = structuredClone(snapshot.community!);
    delete missingTarget.people.find(p => p.task?.kind === 'hunt')!.task!.targetAgentId;
    expect(isCommunityState(missingTarget)).toBe(false);
  });
});
