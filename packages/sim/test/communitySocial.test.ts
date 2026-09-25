import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { communityBiomassKg, isCommunityState } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { learnFromSharedWork, workSkill, type HumanWorkWindow } from '../src/communitySocial.js';
import { stepCommunity } from '../src/community.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const options = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const, initialCommunityRulesVersion: 3 as const, initialAgents: {}, minPopulation: {} };
function fixture() {
  const w = createWorld(options), c = w.community!;
  const [a, b] = c.people;
  a!.skills.building = .2; b!.skills.building = .8;
  const work = (personId: string, skillValue: number): HumanWorkWindow => ({ personId, skillValue,
    action: 'build', skill: 'building', start: 0, end: 3600, position: { ...c.building.position }, taskEventId: `task_${personId}` });
  return { w, c, a: a!, b: b!, windows: [work(a!.id, .2), work(b!.id, .8)] };
}

describe('authoritative shared work and observational learning', () => {
  it('counts only overlapping, nearby work, gaining real bounded skill without creating materials', () => {
    const { w, c, a, b, windows } = fixture(), mass = communityBiomassKg(c);
    windows[0]!.end = 1800; windows[1]!.start = 900; windows[1]!.end = 2700;
    learnFromSharedWork(c, windows, w.log); c.updatedAt = 2700;
    expect(c.relationships).toHaveLength(1);
    expect(c.relationships![0]).toMatchObject({ members: [a.id, b.id], sharedWorkSeconds: 900, lastInteractionAt: 1800, reportedHours: 0 });
    expect(a.skills.building).toBeCloseTo(.2 + .6 * .015 / 4, 12);
    expect(b.skills.building).toBe(.8); expect(communityBiomassKg(c)).toBe(mass);
    expect(c.building.labourSeconds).toBe(0); expect(isCommunityState(c)).toBe(true);
    expect(w.log.all().filter(e => e.type === 'human_skill_learned')).toHaveLength(0);
  });

  it('creates no relationships for non-overlap, distance, different work, idle time or dead people', () => {
    for (const mode of ['nonoverlap', 'distance', 'different', 'idle', 'dead'] as const) {
      const { w, c, b, windows } = fixture();
      if (mode === 'nonoverlap') windows[1]!.start = 3600;
      if (mode === 'distance') windows[1]!.position.x += 3.01;
      if (mode === 'different') { windows[1]!.action = 'gather_food'; windows[1]!.skill = 'gathering'; }
      if (mode === 'idle') for (const window of windows) window.action = 'rest';
      if (mode === 'dead') { b.alive = false; b.diedAt = 0; }
      learnFromSharedWork(c, windows, w.log);
      expect(c.relationships, mode).toEqual([]);
    }
    expect(workSkill('deliver')).toBeNull(); expect(workSkill('sleep')).toBeNull();
    expect(workSkill('fish')).toBe('fishing');
    // The producer records paid work only: these first steps are still travel, not observation.
    const w = createWorld(options);
    stepCommunity(w.community!, w.patches, w.waterBudget, 0, 1, w.log);
    expect(w.community!.people.every(p => p.task?.phase === 'travel')).toBe(true);
    expect(w.community!.relationships).toEqual([]);
  });

  it('clips interaction records and event time at death, retaining history but not posthumous teaching', () => {
    const { w, c, b, windows } = fixture();
    for (const window of windows) window.end = 7200;
    b.alive = false; b.diedAt = 3600;
    learnFromSharedWork(c, windows, w.log);
    expect(c.relationships![0]).toMatchObject({ sharedWorkSeconds: 3600, lastInteractionAt: 3600 });
    expect(w.log.all().filter(e => e.type === 'human_cooperated' || e.type === 'human_skill_learned')
      .every(e => e.worldTime === 3600)).toBe(true);
    for (const window of windows) window.start = 3600;
    const saved = structuredClone(c.relationships);
    learnFromSharedWork(c, windows, w.log); expect(c.relationships).toEqual(saved);
  });

  it('is input-order deterministic and emits grounded milestones with both work attempts as parents', () => {
    const left = fixture(), right = fixture();
    learnFromSharedWork(left.c, left.windows, left.w.log);
    learnFromSharedWork(right.c, right.windows.reverse(), right.w.log);
    expect(left.c).toEqual(right.c); expect(left.w.log.all()).toEqual(right.w.log.all());
    const events = left.w.log.all().filter(e => e.type === 'human_cooperated' || e.type === 'human_skill_learned');
    expect(events.map(e => e.type)).toEqual(['human_cooperated', 'human_skill_learned']);
    expect(events.every(e => e.causalParents.length === 2 && e.confidence === 'authoritative')).toBe(true);
    expect(events[1]!.actors).toEqual([left.a.id, left.b.id, left.c.id]);
    expect(events[1]!.conditions.method).toBe('observed_shared_work');
    expect(events[1]!.effects.skillGain).toBeCloseTo(.009, 12);
  });

  it('never pushes a learner above the demonstrated teacher skill or learns from an equal-skill partner', () => {
    const { w, c, a, windows } = fixture();
    a.skills.building = .79999;
    learnFromSharedWork(c, windows, w.log); expect(a.skills.building).toBe(.8);
    const second = fixture(); second.windows[0]!.skillValue = .8; second.a.skills.building = .8;
    learnFromSharedWork(second.c, second.windows, second.w.log);
    expect(second.c.relationships![0]!.lessons).toEqual([]); expect(second.a.skills.building).toBe(.8);
  });

  it('integrates with finite-stock construction and resumes lessons and milestone counters exactly after JSON restore', () => {
    const a = createWorld(options), baseline = a.totalNutrients();
    a.step(6);
    expect(a.community!.relationships!.length).toBeGreaterThan(0);
    expect(a.community!.relationships!.flatMap(r => r.lessons).some(l => l.gain > 0)).toBe(true);
    expect(a.log.all().some(e => e.type === 'human_cooperated')).toBe(true);
    const b = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(a))), options);
    a.log.take(); expect(b.log.all()).toEqual([]);
    for (let h = 0; h < 42; h++) { a.step(1); b.step(1); }
    expect(takeSnapshot(a)).toEqual(takeSnapshot(b)); expect(a.log.all()).toEqual(b.log.all());
    expect(a.community!.building.stage).toBe('occupied'); expect(isCommunityState(a.community)).toBe(true);
    expect(a.totalNutrients()).toBeCloseTo(baseline, 6);
    const milestones = a.log.all().filter(e => e.type === 'human_cooperated');
    const keys = milestones.map(e => `${e.actors.slice(0, 2).join(':')}:${Math.floor(e.effects.sharedWorkSeconds! / 3600)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps saved rules v2 unchanged even when new worlds default to v3', () => {
    const a = createWorld({ ...options, initialCommunityRulesVersion: 2 }); a.step(6);
    const b = restoreSnapshot(takeSnapshot(a), options); a.log.take();
    for (let h = 0; h < 24; h++) { a.step(1); b.step(1); }
    expect(b.community!.version).toBe(2); expect(b.community!.relationships).toBeUndefined();
    expect(takeSnapshot(a)).toEqual(takeSnapshot(b)); expect(a.log.all()).toEqual(b.log.all());
    expect(b.log.all().some(e => e.type === 'human_cooperated' || e.type === 'human_skill_learned')).toBe(false);
  });

  it('rejects malformed saved relationship identities, counters and lessons', () => {
    const { w, c, windows } = fixture(); learnFromSharedWork(c, windows, w.log); c.updatedAt = 3600;
    expect(isCommunityState(c)).toBe(true);
    for (const mode of ['unknown', 'duplicate', 'future', 'trust', 'counter', 'lesson', 'time', 'legacy'] as const) {
      const bad = structuredClone(c), r = bad.relationships![0]!;
      if (mode === 'unknown') r.members[1] = 'missing';
      if (mode === 'duplicate') bad.relationships!.push(structuredClone(r));
      if (mode === 'future') r.lastInteractionAt++;
      if (mode === 'trust') r.trust = 1;
      if (mode === 'counter') r.reportedHours++;
      if (mode === 'lesson') r.lessons[0]!.teacherId = r.lessons[0]!.learnerId;
      if (mode === 'time') r.lessons[0]!.observedSeconds++;
      if (mode === 'legacy') bad.version = 2;
      expect(isCommunityState(bad), mode).toBe(false);
    }
  });
});
