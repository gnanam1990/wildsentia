import { fileURLToPath } from 'node:url';
import { CONGO_POPULATION, createWorld } from '@vana/sim';

/**
 * Congo 1B: a soak of the Congo forest on its own species. It reports what the plan's gate asks:
 * every species alive, leopards killing both prey, dives happening, nothing stranded in deep
 * water, the body condition of the plant-eaters, and the step time against its 2 s budget.
 */
export interface CongoSoakResult {
  days: number;
  living: Record<string, number>;
  kills: Record<string, number>;
  dives: number;
  /** Non-swimmers in mid-river (a channel patch with no dry ground beside it) at the end of a day: should be none. */
  strandedInWater: number;
  meanCondition: Record<string, number>;
  hourMs: { p95: number; max: number };
}

const SPECIES_DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));

export function runCongoSoak(o: { seed: number; days: number; population?: Record<string, number> }): CongoSoakResult {
  const world = createWorld({ seed: o.seed, speciesDir: SPECIES_DIR, terrainProfile: 'congo_v1',
    initialAgents: o.population ?? CONGO_POPULATION, minPopulation: {}, retainEvents: 20_000 });
  const kills: Record<string, number> = {}, hours: number[] = [];
  let dives = 0, stranded = 0;
  for (let day = 0; day < o.days; day++) {
    for (let h = 0; h < 24; h++) {
      const t = performance.now();
      world.step(1);
      hours.push(performance.now() - t);
      // Drained each hour, as the server does: every event is counted once.
      for (const e of world.log.take()) {
        if (e.type === 'hunt' && e.outcome === 'success') {
          const prey = String(e.conditions.preySpecies ?? world.animal(e.actors[1] ?? '')?.speciesId ?? 'unknown');
          kills[prey] = (kills[prey] ?? 0) + 1;
        }
        if (e.type === 'fled' && e.conditions.escape === 'dive' && e.outcome === 'success') dives++;
      }
    }
    // Mid-river: a channel patch with no dry ground beside it. (A drinker stands just inside a
    // river patch's edge, at its shore; that is not stranded.)
    const midRiver = (id: number) => world.patches[id]!.habitat === 'water'
      && world.patches[id]!.neighbours.every((n) => world.patches[n]!.habitat === 'water');
    stranded += world.agents.filter((a) => a.alive && midRiver(a.patchId) && !world.species.get(a.speciesId)!.locomotion.swims).length;
  }
  const living: Record<string, number> = {}, condition: Record<string, number[]> = {};
  for (const a of world.agents) {
    if (!a.alive) continue;
    living[a.speciesId] = (living[a.speciesId] ?? 0) + 1;
    if (a.condition !== undefined) (condition[a.speciesId] ??= []).push(a.condition);
  }
  hours.sort((a, b) => a - b);
  return {
    days: o.days, living, kills, dives, strandedInWater: stranded,
    meanCondition: Object.fromEntries(Object.entries(condition).map(([id, xs]) => [id, xs.reduce((s, x) => s + x, 0) / xs.length])),
    hourMs: { p95: hours[Math.min(hours.length - 1, Math.ceil(hours.length * 0.95) - 1)]!, max: hours.at(-1)! },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runCongoSoak({ seed: Number(process.env.SEED ?? 7), days: Number(process.env.DAYS ?? 30) });
  console.log(JSON.stringify(r, null, 2));
  const ok = ['blue_duiker', 'water_chevrotain', 'african_leopard'].every((id) => (r.living[id] ?? 0) > 0)
    && (r.kills.blue_duiker ?? 0) > 0 && (r.kills.water_chevrotain ?? 0) > 0 && r.strandedInWater === 0 && r.hourMs.max <= 2_000;
  process.exitCode = ok ? 0 : 1;
}
