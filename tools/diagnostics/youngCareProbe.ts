/**
 * Read-only, all-species young-care trace. Same world options and hourly stepping as the
 * canonical island soak; it observes, never changes a drive or position.
 *
 *   npx tsx tools/diagnostics/youngCareProbe.ts --seed 2 --days 360 --output NEW.json
 *
 * For every unweaned animal with a living parent it keeps a 48-hour ring of hourly
 * child/parent snapshots, and on a starvation/dehydration death with the parent alive it
 * dumps that ring plus a summary of why care did not reach the child: parent away, parent
 * unavailable (and which drive blocked it), and how much was actually provided.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ISLAND_POPULATION, SIM_VERSION, createWorld, restoreSnapshot, upgradeV31Snapshot, type Snapshot } from '@vana/sim';
import type { Agent } from '@vana/shared';
import { availableForCare } from '../../packages/sim/src/agents/family.js';
import { careRadius, needsOf, needsProvisioning } from '../../packages/sim/src/agents/needs.js';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const seed = Number(arg('seed', '1')), days = Number(arg('days', '360')), output = arg('output');
// --checkpoint replays a saved window (islandCheckpoint.ts); a v0.31 save is opted into the
// current rules exactly as the server's explicit upgrade would, for before/after comparison.
const checkpoint = arg('checkpoint');
const options = { seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const, initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 };
const saved = checkpoint ? JSON.parse(readFileSync(checkpoint, 'utf8')) as Snapshot : null;
const world = saved ? restoreSnapshot(saved.simVersion === 'sim_0.31.0'
  ? upgradeV31Snapshot(saved) : saved, { ...options, seed: saved.seed }) : createWorld(options);

type Snap = { t: number; cPatch: number; cGoal: string | null; cState: string; cHunger: number; cThirst: number;
  pPatch: number; pGoal: string | null; pState: string; pHunger: number; pThirst: number; pFear: number;
  available: boolean; distM: number; cPatchWaterL: number; pPatchWaterL: number };
const ring = new Map<string, Snap[]>();
const provided = new Map<string, Array<{ t: number; foodKg: number; waterL: number; parentId: string }>>();
const cases: unknown[] = [];
const summary: Record<string, number> = {};
/** Orphan and weaned-young deprivation ages, as a fraction of the species' weaning age. */
const ages: Record<string, number[]> = {};
const bump = (key: string): void => { summary[key] = (summary[key] ?? 0) + 1; };
const byId = new Map<string, Agent>();

for (let day = 0; day < days; day++) {
  for (let hour = 0; hour < 24; hour++) {
    byId.clear();
    for (const agent of world.agents) byId.set(agent.id, agent);
    const now = world.now();
    for (const child of world.agents) {
      if (!child.alive || !child.dependentOn) continue;
      const cfg = world.species.get(child.speciesId)!;
      if (!needsProvisioning(child, cfg)) { ring.delete(child.id); continue; }
      const parent = byId.get(child.dependentOn);
      if (!parent?.alive || !parent.position || !child.position) continue;
      const list = ring.get(child.id) ?? [];
      list.push({ t: now, cPatch: child.patchId, cGoal: child.currentGoal, cState: child.state,
        cHunger: +child.drives.hunger.toFixed(3), cThirst: +child.drives.thirst.toFixed(3),
        pPatch: parent.patchId, pGoal: parent.currentGoal, pState: parent.state,
        pHunger: +parent.drives.hunger.toFixed(3), pThirst: +parent.drives.thirst.toFixed(3),
        pFear: +parent.drives.fear.toFixed(3), available: availableForCare(parent, child),
        distM: +Math.hypot(parent.position.x - child.position.x, parent.position.z - child.position.z).toFixed(1),
        cPatchWaterL: Math.round(world.patches[child.patchId]!.waterVolume),
        pPatchWaterL: Math.round(world.patches[parent.patchId]!.waterVolume) });
      if (list.length > 48) list.shift();
      ring.set(child.id, list);
    }
    world.step(1);
    for (const event of world.log.take()) {
      if (event.type === 'provisioned') {
        const list = provided.get(event.actors[0]!) ?? [];
        list.push({ t: event.worldTime, foodKg: Number(event.effects.foodEquivalentKg ?? 0),
          waterL: Number(event.effects.waterEquivalentL ?? 0), parentId: event.actors[1]! });
        while (list.length && list[0]!.t < event.worldTime - 72 * 3600) list.shift();
        provided.set(event.actors[0]!, list);
        continue;
      }
      if (event.type !== 'died') continue;
      const cause = String(event.conditions.cause), careState = String(event.conditions.careState);
      const species = String(event.conditions.species);
      if (cause !== 'starvation' && cause !== 'dehydration') continue;
      bump(`${species}/${cause}/${careState}`);
      if (careState !== 'unweaned_with_parent') {
        const wean = world.species.get(species)!.lifecycle.weanDays;
        (ages[`${species}/${cause}/${careState}`] ??= []).push(+(Number(event.conditions.ageDays) / wean).toFixed(2));
        ring.delete(event.actors[0]!); continue;
      }
      const childId = event.actors[0]!;
      const child = world.deceased.find(a => a.id === childId) ?? world.agents.find(a => a.id === childId);
      const cfg = world.species.get(species)!;
      const parent = child?.dependentOn ? world.agents.find(a => a.id === child.dependentOn) : undefined;
      const snaps = ring.get(childId) ?? [];
      const radius = careRadius(cfg);
      const away = snaps.filter(s => s.distM > radius).length;
      const unavailable = snaps.filter(s => !s.available);
      const blockedBy = { thirst: unavailable.filter(s => s.pThirst >= 0.65).length,
        hunger: unavailable.filter(s => s.pHunger >= 0.72).length, fear: unavailable.filter(s => s.pFear >= 0.5).length };
      const parentGoals: Record<string, number> = {};
      for (const s of snaps) parentGoals[String(s.pGoal)] = (parentGoals[String(s.pGoal)] ?? 0) + 1;
      const recent = (provided.get(childId) ?? []).filter(p => p.t >= event.worldTime - 48 * 3600);
      const need = child ? needsOf(child, cfg) : null;
      const record = { childId, species, cause, ageDays: event.conditions.ageDays, day: +(event.worldTime / 86400).toFixed(3),
        parentId: child?.dependentOn ?? null, parentAlive: !!parent?.alive, careRadiusM: radius,
        finalDistM: snaps.at(-1)?.distM ?? null, hoursAway48: away, hoursParentUnavailable48: unavailable.length,
        blockedBy, parentGoals48: parentGoals, provisions48: recent.length,
        provided48: { foodKg: recent.reduce((s, p) => s + p.foodKg, 0), waterL: recent.reduce((s, p) => s + p.waterL, 0) },
        dailyNeed: need, littermates: child?.dependentOn ? world.agents.filter(a => a.alive && a.dependentOn === child.dependentOn).length : null,
        snapshots: snaps };
      cases.push(record);
      console.log(JSON.stringify({ ...record, snapshots: undefined }));
      ring.delete(childId);
    }
  }
  if ((day + 1) % 30 === 0) console.error(`probe seed ${seed}: day ${day + 1}/${days}; ${cases.length} with-parent cases`);
}
const result = { simVersion: SIM_VERSION, seed, days, summary, agesAsWeanFraction: ages, withParentCases: cases.length, cases };
if (output) writeFileSync(output, JSON.stringify(result, null, 1) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ summary, agesAsWeanFraction: ages, withParentCases: cases.length }));
