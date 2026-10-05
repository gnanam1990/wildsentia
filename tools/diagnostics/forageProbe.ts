/**
 * Read-only forage trace from a saved island checkpoint (see islandCheckpoint.ts). Each day it
 * prints island grass/browse stocks, and for the watched species mean hunger, how many are
 * past the care threshold, and per-animal hunger/patch/what they did, so a die-off can be
 * attributed to food that is not there versus food that is there and not reached.
 *
 *   npx tsx tools/diagnostics/forageProbe.ts --checkpoint CK.json --days 100 [--species elephant,gaur]
 */
import { readFileSync } from 'node:fs';
import { restoreSnapshot, perceive, type Snapshot } from '@vana/sim';
import { landWalkable, seasonAt } from '@vana/shared';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const snapshot = JSON.parse(readFileSync(arg('checkpoint')!, 'utf8')) as Snapshot;
const days = Number(arg('days', '60'));
const watch = arg('species', 'elephant,gaur')!.split(',');
const detail = arg('detail', 'elephant')!.split(',');
const world = restoreSnapshot(snapshot, { seed: snapshot.seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: {}, minPopulation: {}, retainEvents: 200_000 });
const view = () => (world as unknown as { __viewForTest(): Parameters<typeof perceive>[2] }).__viewForTest();
const start = world.now() / 86400;
for (let day = 0; day < days; day++) {
  const goals: Record<string, Record<string, number>> = {};
  const deaths: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    world.step(1);
    for (const event of world.log.take()) {
      if (event.type === 'died' && watch.includes(String(event.conditions.species)))
        deaths.push(`${event.actors[0]}:${event.conditions.cause}:${event.conditions.lifeStage}`);
    }
    for (const a of world.agents) if (a.alive && watch.includes(a.speciesId)) {
      const g = (goals[a.speciesId] ??= {});
      g[String(a.currentGoal)] = (g[String(a.currentGoal)] ?? 0) + 1;
    }
  }
  const land = world.patches.filter(landWalkable);
  const grass = land.reduce((s, p) => s + p.plant.grass, 0), browse = land.reduce((s, p) => s + p.plant.browse, 0);
  const capG = land.reduce((s, p) => s + p.capacity.grass, 0), capB = land.reduce((s, p) => s + p.capacity.browse, 0);
  const line: Record<string, unknown> = { day: +(start + day + 1).toFixed(1), season: seasonAt(world.now()),
    grassT: +(grass / 1000).toFixed(1), grassPct: +(100 * grass / capG).toFixed(1),
    browseT: +(browse / 1000).toFixed(1), browsePct: +(100 * browse / capB).toFixed(1), deaths };
  for (const id of watch) {
    const living = world.agents.filter(a => a.alive && a.speciesId === id);
    line[id] = { n: living.length, meanHunger: +(living.reduce((s, a) => s + a.drives.hunger, 0) / Math.max(1, living.length)).toFixed(3),
      over072: living.filter(a => a.drives.hunger >= 0.72).length, goals: goals[id] };
  }
  console.log(JSON.stringify(line));
  for (const a of world.agents) if (a.alive && detail.includes(a.speciesId)) {
    const cfg = world.species.get(a.speciesId)!;
    const p = perceive(a, cfg, view());
    const patch = world.patches[a.patchId]!;
    console.log('   ', a.id, a.sex, Math.floor(a.ageDays), 'mass', Math.round(a.massKg), 'H', a.drives.hunger.toFixed(3),
      'T', a.drives.thirst.toFixed(3), 'patch', a.patchId, patch.habitat, 'here kg', Math.round(patch.plant.grass + patch.plant.browse),
      'best', p.bestFood ? `${p.bestFood.patchId}:${Math.round(p.bestFood.kg)}` : null);
  }
}
