/**
 * Read-only nutrient pool trace from a saved island checkpoint: where the conserved nutrient
 * total sits (soil on grazeable land versus elsewhere, standing plants, animals, carcasses,
 * micro-ecology, household) and how much plant growth soil could still pay for. Separates a
 * forage collapse caused by grazing pressure from one caused by nutrients leaving the soil
 * that grows forage.
 *
 *   npx tsx tools/diagnostics/nutrientPools.ts --checkpoint CK.json --days 90 [--every 10]
 */
import { readFileSync } from 'node:fs';
import { NUTRIENT_PER_KG_BIOMASS, carcassMass, landWalkable, seasonAt } from '@vana/shared';
import { restoreSnapshot, upgradeV31Snapshot, type Snapshot } from '@vana/sim';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const saved = JSON.parse(readFileSync(arg('checkpoint')!, 'utf8')) as Snapshot;
const days = Number(arg('days', '90')), every = Number(arg('every', '10'));
const world = restoreSnapshot(saved.simVersion === 'sim_0.31.0' ? upgradeV31Snapshot(saved) : saved,
  { seed: saved.seed, speciesDir: new URL('../../config/species', import.meta.url).pathname, terrainProfile: 'island_v1',
    communityProfile: 'household_v1', initialAgents: {}, minPopulation: {}, retainEvents: 200_000 });
const report = () => {
  const pools: Record<string, number> = {};
  const add = (k: string, v: number) => { pools[k] = (pools[k] ?? 0) + v; };
  for (const p of world.patches) {
    const grows = landWalkable(p) && p.capacity.grass + p.capacity.browse > 0;
    add(grows ? 'soilWhereForageGrows' : 'soilElsewhere', p.soilNutrients);
    add('plants', (p.plant.grass + p.plant.browse) * NUTRIENT_PER_KG_BIOMASS);
    if (grows && p.soilNutrients < (p.capacity.grass + p.capacity.browse) * 0.05 * NUTRIENT_PER_KG_BIOMASS) add('foragePatchesSoilStarved', 1);
    if (grows) add('foragePatches', 1);
  }
  for (const a of world.agents) if (a.alive) add(`animals`, a.massKg * NUTRIENT_PER_KG_BIOMASS);
  for (const c of world.carcasses) add('carcasses', carcassMass(c.biomass) * NUTRIENT_PER_KG_BIOMASS);
  console.log(JSON.stringify({ day: +(world.now() / 86400).toFixed(1), season: seasonAt(world.now()),
    total: +world.totalNutrients().toFixed(1),
    ...Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, +v.toFixed(1)])) }));
};
report();
for (let day = 1; day <= days; day++) {
  for (let hour = 0; hour < 24; hour++) { world.step(1); world.log.take(); }
  if (day % every === 0) report();
}
