/**
 * Read-only: step a saved island checkpoint hourly until the household state stops satisfying
 * the shared persisted contract (isCommunityState), then save the first invalid state and the
 * last valid one so the broken field can be compared.
 *
 *   npx tsx tools/diagnostics/communityStateProbe.ts --checkpoint CK.json --hours 400 --output PREFIX
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isCommunityState } from '@vana/shared';
import { restoreSnapshot, upgradeV31Snapshot, type Snapshot } from '@vana/sim';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const saved = JSON.parse(readFileSync(arg('checkpoint')!, 'utf8')) as Snapshot;
const world = restoreSnapshot(saved.simVersion === 'sim_0.31.0' ? upgradeV31Snapshot(saved) : saved,
  { seed: saved.seed, speciesDir: new URL('../../config/species', import.meta.url).pathname, terrainProfile: 'island_v1',
    communityProfile: 'household_v1', initialAgents: {}, minPopulation: {}, retainEvents: 200_000 });
const hours = Number(arg('hours', '400')), prefix = arg('output', 'community');
let previous = structuredClone(world.community);
for (let hour = 0; hour < hours; hour++) {
  world.step(1);
  const events = world.log.take().filter(e => e.type.startsWith('human') || e.type.startsWith('community') || e.type.startsWith('building'));
  if (!isCommunityState(world.community)) {
    console.log(`invalid at day ${(world.now() / 86400).toFixed(3)}; events this hour: ${events.map(e => e.type).join(', ')}`);
    writeFileSync(`${prefix}-invalid.json`, JSON.stringify(world.community, null, 1));
    writeFileSync(`${prefix}-valid.json`, JSON.stringify(previous, null, 1));
    process.exit(0);
  }
  previous = structuredClone(world.community);
}
console.log('stayed valid');
