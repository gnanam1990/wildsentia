import { fileURLToPath } from 'node:url';
import { congoRiverAt } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { CONGO_POPULATION } from '../src/index.js';
import { RULES, checkRules, type RuleWorld } from './animalRules.js';

/**
 * The rules of where each animal can be (animalRules.ts), checked for the whole Congo forest of
 * some 41,700 animals every hour, where the rules test runs 520. It also lists any animal that
 * says it is travelling but has not moved for 48 hours. Slow (about three minutes a day), so run
 * by hand: `DAYS=4 npx tsx packages/sim/test/congoAudit.ts > audit.json`.
 */
const DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const world = createWorld({ seed: 7, speciesDir: DIR, terrainProfile: 'congo_v1', initialAgents: CONGO_POPULATION, minPopulation: {}, retainEvents: 20_000 });
const breaks = new Map<string, number>(), checked = new Map<string, number>(), examples = new Map<string, unknown[]>();
const still = new Map<string, { x: number; z: number; since: number }>(), stuck: unknown[] = [], deaths = new Map<string, number>();
const hourMs: number[] = [];
for (let h = 0; h < Number(process.env.DAYS ?? 4) * 24; h++) {
  const t = performance.now(); world.step(1); hourMs.push(performance.now() - t);
  for (const e of world.log.take()) {
    if (e.type !== 'died') continue;
    const k = `${e.actors[0]!.replace(/_[0-9a-f]+$/, '')}:${String((e.conditions as { cause?: string }).cause ?? e.outcome)}`;
    deaths.set(k, (deaths.get(k) ?? 0) + 1);
  }
  const w: RuleWorld = { grid: world.grid, patches: world.patches, species: world.species, seed: 7,
    parents: new Set(world.agents.filter((a) => a.alive && a.dependentOn !== null).map((a) => a.dependentOn!)) };
  checkRules(world.agents, w, breaks, checked);
  for (const a of world.agents) {
    if (!a.alive) continue;
    const cfg = world.species.get(a.speciesId)!;
    for (const rule of RULES) {
      const key = `${rule.id}:${a.speciesId}`, list = examples.get(key) ?? [];
      if (list.length >= 3 || !rule.applies(a, cfg, w) || rule.holds(a, cfg, w)) continue;
      list.push({ hour: h, id: a.id, state: a.state, goal: a.currentGoal, mode: a.locomotionMode, altitudeM: a.altitudeM, habitat: world.patches[a.patchId]!.habitat, position: a.position });
      examples.set(key, list);
    }
    if (!a.position) continue;
    const s = still.get(a.id);
    if (!s || Math.hypot(s.x - a.position.x, s.z - a.position.z) > 1) still.set(a.id, { x: a.position.x, z: a.position.z, since: h });
    else if (h - s.since === 48 && a.state === 'travelling') {
      const r = congoRiverAt(world.grid, world.patches[a.patchId]!.congoSeed!, a.position.x, a.position.z);
      stuck.push({ hour: h, id: a.id, goal: a.currentGoal, habitat: world.patches[a.patchId]!.habitat, inChannelM: Math.round(r.halfM - r.distanceM), hunger: a.drives.hunger });
    }
  }
  if (h % 24 === 23) process.stderr.write(`day ${(h + 1) / 24}: ${[...breaks.values()].reduce((n, b) => n + b, 0)} breaks, ${stuck.length} stuck\n`);
}
const sorted = [...hourMs].sort((a, b) => a - b), at = (f: number) => Math.round(sorted[Math.floor(f * (sorted.length - 1))]!);
const population: Record<string, number> = {};
for (const a of world.agents) if (a.alive) population[a.speciesId] = (population[a.speciesId] ?? 0) + 1;
console.log(JSON.stringify({
  breaks: Object.fromEntries([...breaks].map(([k, n]) => [k, `${n}/${checked.get(k)}`])), examples: Object.fromEntries(examples),
  stuck, deaths: Object.fromEntries([...deaths].sort((a, b) => b[1] - a[1])), population,
  hourMs: { p50: at(0.5), p95: at(0.95), max: at(1) },
}, null, 1));
