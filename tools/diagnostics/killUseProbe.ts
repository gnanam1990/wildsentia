/**
 * Read-only: where the body of every predator kill goes. For each predation death on the island
 * it sums what the killer ate, what other animals ate (by species) and the rest (left to decay),
 * and how long the killer waited before killing again. Separates "predators need this much
 * food" from "predators kill more than they eat".
 *
 *   npx tsx tools/diagnostics/killUseProbe.ts --seed 1 --days 180
 */
import { ISLAND_POPULATION, SIM_VERSION, createWorld } from '@vana/sim';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const seed = Number(arg('seed', '1')), days = Number(arg('days', '180'));
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
type Kill = { killer: string; victimSpecies: string; massKg: number; at: number; byKiller: number; byOthers: Record<string, number> };
const kills = new Map<string, Kill>();
const lastKill = new Map<string, number>();
const gaps: Record<string, number[]> = {};
for (let hour = 0; hour < days * 24; hour++) {
  world.step(1);
  for (const e of world.log.take()) {
    if (e.type === 'died' && e.conditions.cause === 'predation' && e.actors[1]) {
      const killer = e.actors[1];
      const sp = killer.split('_')[0]!;
      if (sp === 'person') continue;
      kills.set(e.actors[0]!, { killer, victimSpecies: String(e.conditions.species), massKg: Number(e.effects.massKg),
        at: e.worldTime, byKiller: 0, byOthers: {} });
      const prev = lastKill.get(killer);
      if (prev !== undefined) (gaps[sp] ??= []).push((e.worldTime - prev) / 86400);
      lastKill.set(killer, e.worldTime);
    }
    if ((e.type === 'fed' || e.type === 'scavenged') && e.actors[1] && kills.has(e.actors[1])) {
      const k = kills.get(e.actors[1])!, kg = Number(e.effects.kg);
      if (e.actors[0] === k.killer) k.byKiller += kg;
      else { const s = e.actors[0]!.split('_')[0]!; k.byOthers[s] = (k.byOthers[s] ?? 0) + kg; }
    }
  }
}
const bySpecies: Record<string, { kills: number; massKg: number; killerKg: number; othersKg: Record<string, number> }> = {};
for (const k of kills.values()) {
  const sp = k.killer.split('_')[0]!;
  const t = (bySpecies[sp] ??= { kills: 0, massKg: 0, killerKg: 0, othersKg: {} });
  t.kills++; t.massKg += k.massKg; t.killerKg += k.byKiller;
  for (const [o, kg] of Object.entries(k.byOthers)) t.othersKg[o] = (t.othersKg[o] ?? 0) + kg;
}
const median = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null;
console.log(JSON.stringify({ simVersion: SIM_VERSION, seed, days, bySpecies: Object.fromEntries(Object.entries(bySpecies).map(([sp, t]) => [sp, {
  kills: t.kills, meanPreyKg: +(t.massKg / t.kills).toFixed(1), shareEatenByKiller: +(t.killerKg / t.massKg).toFixed(3),
  shareEatenByOthers: Object.fromEntries(Object.entries(t.othersKg).map(([o, kg]) => [o, +(kg / t.massKg).toFixed(3)])),
  medianDaysBetweenKillsBySameKiller: median(gaps[sp] ?? []) }])) }, null, 1));
