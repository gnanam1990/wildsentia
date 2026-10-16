import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { patchCentre, treeAnchorForPatch } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { stalkSpeedMs } from '../src/agents/behaviours.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

/** An agile mangabey and a crowned eagle passing 20 m off (a stalking eagle is hidden to 6 m), in a forest patch with a tree. */
function eagleNear(perched: boolean) {
  const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
    initialAgents: { agile_mangabey: 1, crowned_eagle: 1 }, minPopulation: {}, retainEvents: 'all' });
  world.step(9); // mid-morning: both active
  const patch = world.patches.find((p) => p.habitat === 'terra_firme' && treeAnchorForPatch(world.grid, p))!;
  const anchor = treeAnchorForPatch(world.grid, patch)!, c = patchCentre(world.grid, patch.id);
  const monkey = world.agents.find((a) => a.speciesId === 'agile_mangabey')!, eagle = world.agents.find((a) => a.speciesId === 'crowned_eagle')!;
  Object.assign(monkey, { patchId: patch.id, position: perched ? { x: anchor.x, z: anchor.z, heading: 0 } : { x: c.x, z: c.z, heading: 0 },
    dependentOn: null, pregnantSince: null, offspringIds: [], drives: { hunger: 0.1, thirst: 0.1, fatigue: 0, fear: 0.9 } });
  if (perched) Object.assign(monkey, { altitudeM: anchor.climbHeightM, locomotionMode: 'climb', treeAnchorId: anchor.id });
  else { delete monkey.altitudeM; delete monkey.locomotionMode; delete monkey.treeAnchorId; }
  Object.assign(eagle, { patchId: patch.id, position: { x: (perched ? anchor.x : c.x) + 20, z: perched ? anchor.z : c.z, heading: 0 },
    currentGoal: 'wander', state: 'travelling', drives: { hunger: 0, thirst: 0, fatigue: 0.9, fear: 0 } });
  delete eagle.altitudeM; delete eagle.locomotionMode; delete eagle.treeAnchorId;
  world.agents.splice(world.agents.indexOf(monkey), 1); world.agents.unshift(monkey);
  return { world, monkey };
}

// A mangabey escapes a cat by climbing, but an eagle by dropping into cover: crowned eagles take
// monkeys in the canopy and make most kills on the floor (docs/2026-10-15-congo-species-behaviour-audit.md).
describe('the mangabey and the crowned eagle', () => {
  it('does not climb to escape an eagle', () => {
    const { world, monkey } = eagleNear(false);
    world.step(1);
    expect(world.log.all().some((e) => e.type === 'tree_climbed' && e.actors[0] === monkey.id && e.conditions.reason === 'local_threat')).toBe(false);
  }, 120_000);

  it('drops from its tree to cover when an eagle threatens', () => {
    const { world, monkey } = eagleNear(true);
    world.step(1);
    expect(world.log.all().some((e) => e.type === 'tree_climbed' && e.actors[0] === monkey.id
      && e.conditions.direction === 'descend' && e.conditions.reason === 'take_cover')).toBe(true);
  }, 120_000);

  it('lets an eagle close on its prey at flight speed, a cat at a stalk', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1', initialAgents: {}, minPopulation: {} });
    const eagle = world.species.get('crowned_eagle')!, leopard = world.species.get('african_leopard')!;
    expect(stalkSpeedMs(eagle, 1, 2)).toBeCloseTo(eagle.locomotion.sprintMs, 6);
    expect(stalkSpeedMs(leopard, 1, 2)).toBeCloseTo(leopard.locomotion.walkMs * 0.45 / 2, 6);
  });
});
