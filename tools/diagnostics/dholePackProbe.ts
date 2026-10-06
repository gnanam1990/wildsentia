/**
 * Read-only dhole pack trace on the canonical island (sim_0.36.0 pack hunting).
 *
 *   npx tsx tools/diagnostics/dholePackProbe.ts --seed 3 --days 360
 *
 * Every ten days it prints the pack (adults, pups, mean hunger and stomach), its hunts in that
 * window (led, joined, party sizes, success, kills and kilograms by prey) and the meat its
 * members ate. Each dhole death is printed with the animal's last 48 hourly goals and drives.
 */
import { ISLAND_POPULATION, createWorld } from '@vana/sim';
import { needsProvisioning } from '../../packages/sim/src/agents/needs.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const seed = Number(arg('seed', '1')), days = Number(arg('days', '360'));
// --trace-from/--trace-to print every dhole's hourly state (with any pack food it carries) in a window.
const traceFrom = Number(arg('trace-from', 'Infinity')), traceTo = Number(arg('trace-to', '-Infinity'));
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
const dhole = world.species.get('dhole')!;
const ring = new Map<string, string[]>();
let window = { hunts: 0, packHunts: 0, kills: 0, partySizes: [] as number[], killsByPrey: {} as Record<string, number>,
  kgByPrey: {} as Record<string, number>, eatenKg: 0, scavengedKg: 0 };

for (let day = 0; day < days; day++) {
  for (let hour = 0; hour < 24; hour++) {
    for (const a of world.agents) if (a.alive && a.speciesId === 'dhole') {
      const list = ring.get(a.id) ?? [];
      list.push(`${(world.now() / 86400).toFixed(2)} ${a.currentGoal}/${a.state} h${a.drives.hunger.toFixed(2)} t${a.drives.thirst.toFixed(2)} f${a.drives.fear.toFixed(2)} g${(a.gutKg ?? 0).toFixed(1)} p${a.patchId}`);
      if (list.length > 48) list.shift();
      ring.set(a.id, list);
      if (day >= traceFrom && day < traceTo) console.log(`${a.id} ${a.ageDays.toFixed(0)}d ${list.at(-1)}${a.packFood ? ` carrying ${a.packFood.kg.toFixed(2)}kg for ${a.packFood.recipientId}` : ''}`);
    }
    world.step(1);
    for (const e of world.log.take()) {
      if (e.type === 'hunt' && e.conditions.predatorSpecies === 'dhole') {
        window.hunts++;
        const party = Number(e.conditions.packHunters ?? 1);
        if (party > 1) window.packHunts++;
        window.partySizes.push(party);
        if (e.outcome === 'success') {
          window.kills++;
          const prey = String(e.conditions.preySpecies);
          window.killsByPrey[prey] = (window.killsByPrey[prey] ?? 0) + 1;
          window.kgByPrey[prey] = (window.kgByPrey[prey] ?? 0) + Number(e.effects.preyMassKg ?? 0);
        }
      } else if ((e.type === 'fed' || e.type === 'scavenged') && e.actors[0]?.startsWith('dhole_')) {
        if (e.type === 'fed') window.eatenKg += Number(e.effects.kg ?? 0); else window.scavengedKg += Number(e.effects.kg ?? 0);
      } else if (e.type === 'died' && e.conditions.species === 'dhole') {
        console.log(JSON.stringify({ died: e.actors[0], day: +(e.worldTime / 86400).toFixed(2), cause: e.conditions.cause,
          careState: e.conditions.careState, ageDays: e.conditions.ageDays, last48: ring.get(e.actors[0]!) }));
        ring.delete(e.actors[0]!);
      }
    }
  }
  if ((day + 1) % 10 === 0) {
    const pack = world.agents.filter(a => a.alive && a.speciesId === 'dhole');
    const adults = pack.filter(a => !needsProvisioning(a, dhole));
    const sizes = window.partySizes;
    console.log(JSON.stringify({ day: day + 1, adults: adults.length, pups: pack.length - adults.length,
      meanHunger: adults.length ? +(adults.reduce((s, a) => s + a.drives.hunger, 0) / adults.length).toFixed(2) : null,
      meanGutKg: adults.length ? +(adults.reduce((s, a) => s + (a.gutKg ?? 0), 0) / adults.length).toFixed(2) : null,
      hunts: window.hunts, packHunts: window.packHunts, meanParty: sizes.length ? +(sizes.reduce((s, n) => s + n, 0) / sizes.length).toFixed(2) : null,
      kills: window.kills, killsByPrey: window.killsByPrey, kgKilled: Math.round(Object.values(window.kgByPrey).reduce((s, n) => s + n, 0)),
      eatenKg: Math.round(window.eatenKg), scavengedKg: Math.round(window.scavengedKg) }));
    window = { hunts: 0, packHunts: 0, kills: 0, partySizes: [], killsByPrey: {}, kgByPrey: {}, eatenKg: 0, scavengedKg: 0 };
  }
}
