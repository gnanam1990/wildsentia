import { fileURLToPath } from 'node:url';
import type { Agent, Carcass, Patch, SpeciesConfig } from '@vana/shared';
import { loadSpeciesDir } from '../src/config/loader.js';
import type { WorldView } from '../src/agents/perception.js';
import type { WorldServices } from '../src/agents/behaviours.js';
import { makeCarcass } from '../src/fields/decomposition.js';

export const SPECIES_DIR = fileURLToPath(new URL('../../../config/species', import.meta.url));
export const SPECIES = loadSpeciesDir(SPECIES_DIR);

export function speciesOf(id: string): SpeciesConfig {
  const config = SPECIES.get(id);
  if (config === undefined) throw new Error(`no such species in the roster: ${id}`);
  return config;
}

export function makeAgent(speciesId: string, overrides: Partial<Agent> = {}): Agent {
  const config = speciesOf(speciesId);
  return {
    id: `${speciesId}_test`, speciesId, bornAt: 0,
    massKg: config.body.adultMassKg,
    patchId: 0, state: 'resting', currentGoal: 'wander', alternativeGoal: null,
    goalScore: 0, targetId: null, stamina: 1,
    sex: 'female',
    ageDays: config.lifecycle.sexualMaturityDays + 100,
    lifeStage: 'adult',
    traits: {
      sizeTendency: 0.5, boldness: 0.5, endurance: 0.5,
      sensoryAcuity: 0.5, diseaseResistance: 0.5, coatVariant: 0.5,
    },
    motherId: null, fatherId: null, generation: 0,
    dependentOn: null, pregnantSince: null, lastBirthAt: null, offspringIds: [],
    drives: { hunger: 0.2, thirst: 0.2, fatigue: 0.2, fear: 0 },
    alive: true,
    ...overrides,
  };
}

/** A world view backed by plain arrays, so behaviour can be tested without a World. */
export function makeView(patches: Patch[], agents: Agent[] = [], carcasses: Carcass[] = []): WorldView {
  return {
    patches,
    agentsInPatch: (patchId) => agents.filter((a) => a.alive && a.patchId === patchId),
    carcassesInPatch: (patchId) => carcasses.filter((c) => c.patchId === patchId),
    speciesOf,
  };
}

export function makeServices(carcasses: Carcass[]): WorldServices {
  let seq = 0;
  return {
    kill(victim, cause, _killerId, context) {
      victim.alive = false;
      victim.state = 'dead';
      const carcass = makeCarcass(
        `carc_test_${seq++}`, victim.id, victim.speciesId, victim.patchId, context?.at ?? 0,
        cause, 'authoritative', victim.massKg,
      );
      if (victim.position) carcass.position = { ...victim.position };
      carcasses.push(carcass);
      return carcass;
    },
    removeCarcassIfSpent() { /* the tests inspect carcasses directly */ },
    practised() { /* learning is tested on its own */ },
  };
}
