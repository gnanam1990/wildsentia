/**
 * Read-only: a mother and her dependent young, hour by hour, in a window of an island run: each
 * one's patch, goal, state, drives and gut, the carrion each perceives, and the moves, feeds and
 * provisioning they make. Finds how a litter came to be split, or why care did not reach it.
 *
 *   npx tsx tools/diagnostics/familyView.ts --seed 1 --id leopard_0b3a --from 185 --to 200 [--profile island_v2]
 */
import { createWorld, islandPopulation } from '@vana/sim';
import { edibleMass } from '@vana/shared';
import { perceive } from '../../packages/sim/src/agents/perception.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const seed = Number(arg('seed', '1')), id = arg('id', ''), from = Number(arg('from', '0')), to = Number(arg('to', '1'));
const profile = arg('profile', 'island_v2') as 'island_v1' | 'island_v2';
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: profile, communityProfile: 'household_v1', initialAgents: islandPopulation(profile),
  minPopulation: {}, retainEvents: 2_000 });
const watched = () => [id, ...world.agents.filter(a => a.dependentOn === id).map(a => a.id)];
for (let h = 0; h < to * 24; h++) {
  const ids = watched();
  if (h >= from * 24) {
    const line: string[] = [(world.now() / 86400).toFixed(2)];
    for (const who of ids) {
      const a = world.animal(who);
      if (!a?.alive) continue;
      const cfg = world.species.get(a.speciesId)!;
      const p = perceive(a, cfg, world.__viewForTest());
      line.push(`${who.slice(-4)} a${a.ageDays.toFixed(0)} p${a.patchId} ${a.currentGoal}/${a.state} h${a.drives.hunger.toFixed(2)}`
        + ` t${a.drives.thirst.toFixed(2)} g${(a.gutKg ?? 0).toFixed(1)} c${p.carrion ? `${p.carrion.carcass.patchId}:${edibleMass(p.carrion.carcass.biomass).toFixed(0)}` : '-'}`);
    }
    console.log(line.join(' | '));
  }
  world.step(1);
  for (const e of world.log.take()) if (h >= from * 24 && ids.includes(e.actors[0]!)
    && ['moved', 'hunt', 'fed', 'scavenged', 'provisioned', 'fled', 'death', 'birth', 'drank'].includes(e.type))
    console.log(`   ${e.actors[0]!.slice(-4)} ${e.type} ${e.outcome} p${e.patchId} ${JSON.stringify(e.conditions).slice(0, 160)}`);
}
