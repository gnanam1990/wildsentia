/**
 * Read-only forage budget for a saved island checkpoint: the plant growth the island's grazeable
 * patches can make per day in each season (from plants.ts, at their saved soil moisture) when
 * the standing crop is grazed bare and when it is at half capacity, against the daily plant
 * intake of the living herbivores (needsOf, weighted by each species' plant diet share).
 *
 *   npx tsx tools/diagnostics/forageBudget.ts --checkpoint CK.json
 */
import { readFileSync } from 'node:fs';
import { landWalkable, type Patch } from '@vana/shared';
import { BASELINE_REGROWTH_PER_HOUR, PLANT_GROWTH_RATE_PER_HOUR, SEASON_GROWTH_FACTOR, loadSpeciesDir, type Snapshot } from '@vana/sim';
import { needsOf } from '../../packages/sim/src/agents/needs.js';

const i = process.argv.indexOf('--checkpoint');
const saved = JSON.parse(readFileSync(process.argv[i + 1]!, 'utf8')) as Snapshot;
const species = loadSpeciesDir(new URL('../../config/species', import.meta.url).pathname);
const land = saved.patches.filter((p: Patch) => landWalkable(p) && p.capacity.grass + p.capacity.browse > 0);
const capacity = land.reduce((s, p) => s + p.capacity.grass + p.capacity.browse, 0);
const growthPerDay = (season: keyof typeof SEASON_GROWTH_FACTOR, standing: number) => land.reduce((sum, p) => {
  const factor = SEASON_GROWTH_FACTOR[season] * (0.4 + p.soilMoisture * 0.6);
  const cap = p.capacity.grass + p.capacity.browse, current = cap * standing;
  return sum + 24 * factor * (1 - standing) * (current * PLANT_GROWTH_RATE_PER_HOUR + cap * BASELINE_REGROWTH_PER_HOUR);
}, 0);
const demand: Record<string, number> = {};
for (const a of saved.agents) {
  if (!a.alive) continue;
  const cfg = species.get(a.speciesId)!;
  const plantShare = cfg.diet.eats.filter(e => e.target === 'grass' || e.target === 'browse').reduce((s, e) => s + e.preference, 0)
    / Math.max(1e-9, cfg.diet.eats.reduce((s, e) => s + e.preference, 0));
  if (plantShare <= 0) continue;
  demand[a.speciesId] = (demand[a.speciesId] ?? 0) + needsOf(a, cfg).foodKg * plantShare;
}
const t = (kg: number) => +(kg / 1000).toFixed(2);
console.log(JSON.stringify({ day: saved.worldTime / 86400, grazeablePatches: land.length, capacityT: t(capacity),
  standingT: t(land.reduce((s, p) => s + p.plant.grass + p.plant.browse, 0)),
  meanSoilMoisture: +(land.reduce((s, p) => s + p.soilMoisture, 0) / land.length).toFixed(3),
  growthTPerDay: Object.fromEntries((['monsoon', 'wet', 'transition', 'dry'] as const).map(s =>
    [s, { bare: t(growthPerDay(s, 0)), tenPct: t(growthPerDay(s, 0.1)), half: t(growthPerDay(s, 0.5)) }])),
  plantDemandTPerDay: t(Object.values(demand).reduce((s, v) => s + v, 0)),
  bySpeciesT: Object.fromEntries(Object.entries(demand).map(([k, v]) => [k, t(v)])) }, null, 1));
