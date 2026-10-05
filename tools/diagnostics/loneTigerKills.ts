/**
 * Read-only: one tiger among plentiful deer on the mainland grid for 90 days; prints its kills,
 * the gaps between them and its hunger at each kill. Checks the satiety rules against the
 * field kill interval (about one large kill every 7-8 days) without a population's noise.
 *
 *   npx tsx tools/diagnostics/loneTigerKills.ts [--seed 4] [--days 90]
 */
import { createWorld } from '@vana/sim';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : fallback; };
const seed = Number(arg('seed', '4')), days = Number(arg('days', '90'));
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  initialAgents: { tiger: 1, chital: 300, sambar: 80 }, minPopulation: {} });
const tiger = world.agents.find(a => a.speciesId === 'tiger')!;
const kills: Array<{ day: number; prey: string; hunger: number }> = [];
let attempts = 0;
for (let h = 0; h < days * 24 && tiger.alive; h++) {
  world.step(1);
  for (const e of world.log.take()) {
    if (e.type !== 'hunt' || e.actors[0] !== tiger.id) continue;
    attempts++;
    if (e.outcome === 'success') kills.push({ day: +(e.worldTime / 86400).toFixed(2), prey: String(e.conditions.preySpecies), hunger: +tiger.drives.hunger.toFixed(2) });
  }
}
const gaps = kills.slice(1).map((k, i) => +(k.day - kills[i]!.day).toFixed(2));
console.log(JSON.stringify({ seed, days, alive: tiger.alive, attempts, kills: kills.length,
  successRate: +(kills.length / Math.max(1, attempts)).toFixed(3), killsPerYear: +(kills.length * 360 / days).toFixed(1),
  medianGapDays: [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? null, gaps, killRecords: kills }, null, 1));
