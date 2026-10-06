/**
 * Read-only island trace of the sim_0.37.0 changes: the leopard, the dhole den mother and pack,
 * and the wild boar's rooting food and body condition.
 *
 *   npx tsx tools/diagnostics/guildProbe.ts --seed 2 --days 360 [--every 30] [--set dhole=6] [--profile island_v1]
 *
 * Every window it prints the counts of the main species, the boar's mean condition and hunger,
 * the rooting food standing as a share of capacity, and the window's hunts and kills by leopards,
 * tigers and dholes (kills by prey). Every leopard and adult dhole death is printed with its cause.
 */
import { createWorld, islandPopulation } from '@vana/sim';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const seed = Number(arg('seed', '1')), days = Number(arg('days', '360')), every = Number(arg('every', '30'));
// --set dhole=6 overrides one founding count, for trials.
const profile = arg('profile', 'island_v2') as 'island_v1' | 'island_v2';
const founding = { ...islandPopulation(profile) };
for (const [id, n] of process.argv.flatMap((a, i) => process.argv[i - 1] === '--set' ? [a.split('=')] : [])) founding[id!] = Number(n);
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: profile, communityProfile: 'household_v1', initialAgents: founding,
  minPopulation: {}, retainEvents: 200_000 });
const SHOWN = ['chital', 'sambar', 'boar', 'hare', 'langur', 'gaur', 'jackal', 'tiger', 'leopard', 'dhole'];
type Tally = { hunts: number; kills: number; byPrey: Record<string, number> };
const empty = (): Record<string, Tally> => Object.fromEntries(['tiger', 'leopard', 'dhole'].map(id => [id, { hunts: 0, kills: 0, byPrey: {} }]));
let window = empty();
const births: Record<string, number> = {};
const deaths: Record<string, number> = {};

// --trace leopard_0553 --trace-from 270 prints that animal's hourly goal, state, drives and patch.
const traced = arg('trace', ''), traceFrom = Number(arg('trace-from', '0'));
for (let day = 0; day < days; day++) {
  for (let hour = 0; hour < 24; hour++) {
    const t = traced && day >= traceFrom ? world.animal(traced) : undefined;
    if (t?.alive) console.log(`  trace ${(world.now() / 86400).toFixed(2)} ${t.currentGoal}/${t.state} h${t.drives.hunger.toFixed(2)}`
      + ` t${t.drives.thirst.toFixed(2)} f${t.drives.fear.toFixed(2)} g${(t.gutKg ?? 0).toFixed(1)} p${t.patchId} st${(t.stamina ?? 1).toFixed(2)}`
      + ` young ${world.agents.filter(a => a.alive && a.dependentOn === t.id).map(a => `${a.ageDays.toFixed(0)}d h${a.drives.hunger.toFixed(2)}`).join(',')}`);
    world.step(1);
    for (const e of world.log.take()) {
      if (traced && e.actors.includes(traced) && day >= traceFrom && ['hunt', 'fed', 'scavenged', 'died'].includes(e.type))
        console.log(`  trace-event ${e.type} ${e.outcome} ${JSON.stringify(e.conditions).slice(0, 160)} ${JSON.stringify(e.effects)}`);
      if (e.type === 'hunt') {
        const t = window[String(e.conditions.predatorSpecies)];
        if (!t) continue;
        t.hunts++;
        if (e.outcome === 'success') {
          t.kills++;
          const prey = String(e.conditions.preySpecies);
          t.byPrey[prey] = (t.byPrey[prey] ?? 0) + 1;
        }
      } else if (e.type === 'born') {
        const sp = String(e.conditions.species);
        births[sp] = (births[sp] ?? 0) + 1;
      } else if (e.type === 'died') {
        const sp = String(e.conditions.species), cause = String(e.conditions.cause);
        deaths[`${sp}/${cause}`] = (deaths[`${sp}/${cause}`] ?? 0) + 1;
        if (sp === 'leopard' || sp === 'dhole' && e.conditions.lifeStage !== 'newborn')
          console.log(`  day ${(e.worldTime / 86400).toFixed(1)} ${e.actors[0]} ${sp} ${String(e.conditions.lifeStage)} died: ${cause}`
            + `${e.actors[1] ? ` (killer ${e.actors[1]})` : ''} hunger ${Number(e.conditions.hunger).toFixed(2)}`);
      } else if (e.type === 'immigration') {
        console.log(`  day ${(e.worldTime / 86400).toFixed(1)} arrival ${e.actors[0]} ${String(e.conditions.species)}`);
      }
    }
  }
  if ((day + 1) % every !== 0 && day + 1 !== days) continue;
  const counts = SHOWN.map(id => `${id} ${world.livingCount(id)}`).join(', ');
  const boar = world.agents.filter(a => a.alive && a.speciesId === 'boar' && a.lifeStage === 'adult');
  const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
  const pools = world.patches.filter(p => p.rooting);
  const rooting = pools.reduce((s, p) => s + p.rooting!.kg, 0) / Math.max(1, pools.reduce((s, p) => s + p.rooting!.capacityKg, 0));
  const pack = world.agents.filter(a => a.alive && a.speciesId === 'dhole');
  console.log(`day ${day + 1}: ${counts}`);
  console.log(`  boar adults ${boar.length} condition ${mean(boar.map(a => a.condition ?? NaN)).toFixed(2)} hunger ${mean(boar.map(a => a.drives.hunger)).toFixed(2)}`
    + ` pregnant ${boar.filter(a => a.pregnantSince !== null).length}; rooting food ${(rooting * 100).toFixed(0)}% of capacity`);
  console.log(`  dholes: ${pack.filter(a => a.dependentOn === null).length} independent, ${pack.filter(a => a.dependentOn !== null).length} young;`
    + ` leopards ${world.agents.filter(a => a.alive && a.speciesId === 'leopard').map(a => `${a.id}/${a.sex}/${a.lifeStage}/h${a.drives.hunger.toFixed(2)}`).join(' ')}`);
  for (const [sp, t] of Object.entries(window))
    console.log(`  ${sp}: ${t.hunts} hunts, ${t.kills} kills ${JSON.stringify(t.byPrey)}`);
  window = empty();
}
console.log(`births ${JSON.stringify(births)}`);
console.log(`deaths ${JSON.stringify(deaths)}`);
