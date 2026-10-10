import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { WORLD_SECONDS_PER_DAY } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { takeSnapshot } from '../src/snapshot.js';
import { assertNutrientsConserved } from '../src/fields/nutrients.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const options = { seed: 5, speciesDir, initialAgents: { sambar: 40 }, minPopulation: { sambar: 40 } };

describe('World', () => {
  it('spawns the requested population', () => {
    expect(createWorld(options).livingCount('sambar')).toBe(40);
  });

  it('advances the clock by the hours stepped', () => {
    const w = createWorld(options);
    w.step(24);
    expect(w.now()).toBe(WORLD_SECONDS_PER_DAY);
  });

  it('finds an animal in the patch it moved to during the hour, not the one it left', () => {
    const w = createWorld(options);
    w.step(1);
    const mover = w.agents.find((a) => a.alive)!, from = mover.patchId;
    const to = w.patches.find((p) => p.id !== from && w.__viewForTest().agentsInPatch(p.id).length === 0 && p.neighbours.length > 0)!.id;
    expect(w.__viewForTest().agentsInPatch(from)).toContain(mover);
    // Moving mid-hour, as a route or a chase does: the index is not rebuilt until the next hour.
    mover.patchId = to;
    const view = w.__viewForTest();
    expect(view.agentsInPatch(to)).toEqual([mover]);
    expect(view.agentsInPatch(from)).not.toContain(mover);
  });

  it('is deterministic for a given seed', () => {
    const a = createWorld(options);
    const b = createWorld(options);
    for (let i = 0; i < 200; i++) { a.step(1); b.step(1); }
    expect(a.log.size()).toBe(b.log.size());
    expect(a.agents.map((x) => [x.id, x.patchId, x.drives.hunger]))
      .toEqual(b.agents.map((x) => [x.id, x.patchId, x.drives.hunger]));
  });

  it('conserves nutrients across 90 world-days', () => {
    const w = createWorld(options);
    const baseline = w.totalNutrients();
    for (let h = 0; h < 90 * 24; h++) w.step(1);
    assertNutrientsConserved(baseline, w.totalNutrients(), 1e-2);
  });

  it('sustains the population and breeds rather than importing', () => {
    // Hares as well (sim_0.37.0): sambar now die rarely of anything but predation and want.
    const w = createWorld({ ...options, initialAgents: { sambar: 40, hare: 40 }, minPopulation: { sambar: 10 } });
    for (let h = 0; h < 400 * 24; h++) w.step(1);
    expect(w.livingCount('sambar')).toBeGreaterThanOrEqual(10);
    expect(w.births).toBeGreaterThan(0);
    for (const agent of w.agents) {
      if (agent.motherId === null) continue;
      expect(agent.generation).toBeGreaterThan(0);
      expect(w.pedigree.parentsOf(agent.id)).not.toBeNull();
    }
  });

  it('rescues a species that falls below its viability floor', () => {
    const w = createWorld({ ...options, initialAgents: { sambar: 2 }, minPopulation: { sambar: 12 } });
    w.step(1);
    expect(w.livingCount('sambar')).toBeGreaterThanOrEqual(12);
    expect(w.log.all().some((e) => e.type === 'immigration')).toBe(true);
  });

  it('never produces NaN or negative biomass', () => {
    const w = createWorld(options);
    for (let h = 0; h < 120 * 24; h++) w.step(1);
    for (const p of w.patches) {
      expect(Number.isFinite(p.plant.grass)).toBe(true);
      expect(p.plant.grass).toBeGreaterThanOrEqual(0);
      expect(p.soilNutrients).toBeGreaterThanOrEqual(0);
      expect(p.waterVolume).toBeGreaterThanOrEqual(0);
    }
  });

  it('has mothers teach their dependent young what they do well', () => {
    // The owner's central idea (spec §8): parents teach their young, and what they teach shapes
    // who the young become. Every lesson that moves a pupil a tenth is recorded, naming both.
    // Hares as well (sim_0.37.0): sambar now die rarely of anything but predation and want.
    const w = createWorld({ ...options, initialAgents: { sambar: 40, hare: 40 }, minPopulation: { sambar: 10 } });
    const lessons: Array<{ pupil: string; teacher: string; skill: string }> = [];
    for (let h = 0; h < 400 * 24; h++) {
      w.step(1);
      for (const e of w.log.take()) {
        if (e.type === 'skill_taught') {
          lessons.push({ pupil: e.actors[0]!, teacher: e.actors[1]!, skill: String(e.conditions.skill) });
        }
      }
    }
    expect(lessons.length).toBeGreaterThan(0);
    const everyone = new Map([...w.agents, ...w.deceased].map((a) => [a.id, a]));
    for (const lesson of lessons) expect(everyone.get(lesson.pupil)?.motherId).toBe(lesson.teacher);
    expect(new Set(lessons.map((l) => l.skill))).toContain('forage_efficiency');
  });

  it('releases the long dead from memory, keeping the recently dead a newborn may still need', () => {
    // A world that runs for years kept every animal that ever died in memory and in every
    // hourly snapshot. The host archives them to the database and releases them here, but only
    // once they are old enough that no pregnancy can still name them as the father.
    // Hares as well (sim_0.37.0): sambar now die rarely of anything but predation and want.
    const w = createWorld({ ...options, initialAgents: { sambar: 40, hare: 40 }, minPopulation: { sambar: 10 } });
    for (let h = 0; h < 200 * 24; h++) w.step(1);
    expect(w.deceased.length).toBeGreaterThan(0);
    for (const dead of w.deceased) expect(typeof dead.departedAt).toBe('number');
    const cutoff = 100 * WORLD_SECONDS_PER_DAY;
    const old = w.deceased.filter((a) => a.departedAt! < cutoff).map((a) => a.id);
    const released = w.releaseDeceased(cutoff);
    expect(released.map((a) => a.id).sort()).toEqual(old.sort());
    expect(w.deceased.every((a) => a.departedAt! >= cutoff)).toBe(true);
  });
});


describe('spawn records', () => {
  it('names the patch the animal was placed in, after it joined its group', () => {
    // A founding herd or pack member is moved to its group's home when it joins it; the record
    // named the patch drawn before that move. (An immigrant stays at the edge it crossed.)
    const world = createWorld({ seed: 3, speciesDir, initialAgents: { chital: 12, dhole: 5, tiger: 2 }, minPopulation: {} });
    const spawned = world.log.all().filter(e => e.type === 'agent_spawned');
    expect(spawned).toHaveLength(19);
    for (const event of spawned) expect(event.patchId).toBe(world.agents.find(a => a.id === event.actors[0])!.patchId);
  });
});

describe('social groups', () => {
  it('drop members that have died, and a group none of whose members live', () => {
    // Every death stayed listed in its group forever, and a group whose members had all died
    // stayed open: the next founder or immigrant of its kind joined the dead group.
    const world = createWorld({ seed: 4, speciesDir, initialAgents: { dhole: 5 }, minPopulation: {} });
    const pack = world.agents.filter(a => a.speciesId === 'dhole');
    const groupId = pack[0]!.groupId!;
    expect(pack.every(a => a.groupId === groupId)).toBe(true);
    for (const dhole of pack.slice(0, 2)) dhole.drives.hunger = 1;
    world.step(1);
    const living = pack.filter(a => a.alive).map(a => a.id);
    expect(living).toHaveLength(3);
    const group = () => takeSnapshot(world).groups.find(([id]) => id === groupId)?.[1];
    expect(group()!.memberIds).toEqual(living);
    for (const dhole of pack) dhole.drives.hunger = 1;
    world.step(1);
    expect(group()).toBeUndefined();
  });
});
