/**
 * Read-only: what one hunter perceives, hour by hour, in a window of an island run: its goal and
 * state, the prey it perceives (by species and patch), its target, whether the target shares its
 * patch, the threat it detects and its hunger. Finds why a predator travels without attacking.
 *
 *   npx tsx tools/diagnostics/hunterView.ts --seed 1 --id leopard_0b3a --from 69 --to 72 [--profile island_v2]
 */
import { createWorld, islandPopulation } from '@vana/sim';
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
for (let h = 0; h < to * 24; h++) {
  const a = world.animal(id);
  if (h >= from * 24 && a?.alive) {
    const cfg = world.species.get(a.speciesId)!;
    const p = perceive(a, cfg, world.__viewForTest());
    const prey: Record<string, number> = {};
    for (const c of p.prey) { const k = `${c.agent.speciesId}@${c.patchId === a.patchId ? 'here' : c.patchId}`; prey[k] = (prey[k] ?? 0) + 1; }
    const target = a.targetId ? world.animal(a.targetId) : undefined;
    console.log(`${(world.now() / 86400).toFixed(2)} ${a.currentGoal}/${a.state} h${a.drives.hunger.toFixed(2)} p${a.patchId}`
      + ` target ${a.targetId ?? '-'}${target ? `@${target.patchId}` : ''} threat ${p.threat ? `${p.threat.agent.speciesId}@${p.threat.patchId}` : '-'}`
      + ` dangerous ${[...p.dangerous].join(',')} prey ${JSON.stringify(prey)}`);
  }
  world.step(1);
  for (const e of world.log.take()) if (h >= from * 24 && e.actors[0] === id && (e.type === 'hunt' || e.type === 'moved' || e.type === 'fled'))
    console.log(`   ${e.type} ${e.outcome} ${JSON.stringify(e.conditions).slice(0, 140)}`);
}
