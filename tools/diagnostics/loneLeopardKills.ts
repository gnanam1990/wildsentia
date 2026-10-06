/**
 * Calibration check for the leopard's feeding (sim_0.37.0), as loneTigerKills.ts is for the tiger:
 * one leopard among chital, boar, langur and hare on the mainland grid, no other predators.
 *
 *   npx tsx tools/diagnostics/loneLeopardKills.ts --seed 4 --days 90
 *
 * Prints kills (by prey and prey mass), the median days between kills, hunt success by stage and
 * the leopard's hunger at the end. Field: one kill every 5.6 days, one ungulate every 10.6 days
 * (Odden & Wegge 2009, Bardia).
 */
import { createWorld } from '@vana/sim';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const seed = Number(arg('seed', '4')), days = Number(arg('days', '90'));
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  initialAgents: { leopard: 1, chital: 300, boar: 100, langur: 80, hare: 150 }, minPopulation: {} });
const leopard = world.agents.find(a => a.speciesId === 'leopard')!;
const kills: Array<{ day: number; prey: string; kg: number }> = [];
const stages: Record<string, number> = {};
for (let h = 0; h < days * 24 && leopard.alive; h++) {
  world.step(1);
  for (const e of world.log.take()) {
    if (e.type !== 'hunt' || e.actors[0] !== leopard.id) continue;
    const stage = `${String(e.conditions.preySpecies)}:${String(e.conditions.stage)}`;
    stages[stage] = (stages[stage] ?? 0) + 1;
    if (e.outcome === 'success') kills.push({ day: e.worldTime / 86400, prey: String(e.conditions.preySpecies), kg: Number(e.effects.preyMassKg) });
  }
}
const gaps = kills.slice(1).map((k, i) => k.day - kills[i]!.day).sort((a, b) => a - b);
console.log(JSON.stringify({ seed, sex: leopard.sex, massKg: leopard.massKg, alive: leopard.alive, hunger: leopard.drives.hunger,
  kills: kills.length, perYear: kills.length * 360 / days, medianGapDays: gaps[Math.floor(gaps.length / 2)] ?? null,
  byPrey: kills.reduce<Record<string, number>>((m, k) => ({ ...m, [k.prey]: (m[k.prey] ?? 0) + 1 }), {}),
  meanPreyKg: kills.reduce((s, k) => s + k.kg, 0) / Math.max(1, kills.length), stages }, null, 1));
